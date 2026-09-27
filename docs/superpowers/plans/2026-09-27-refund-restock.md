# Refund Restock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin return units to stock when a refunded order's goods come back, per order line, so refunds stop silently destroying inventory.

**Architecture:** A new `restockOrderItems` primitive in `src/lib/inventory` adds units to `inventory.on_hand`, increments a new `order_items.restocked_quantity`, and records the movement in the existing (currently unused) `inventory_adjustments` ledger. A thin `src/lib/orders/restock.ts` wraps it in a transaction and stamps `orders.stock_decision_at`. The admin order page grows a Stock panel offering *Return to stock* and *Write off*.

**Tech Stack:** Next.js 16.3.5 (App Router, Server Components, Server Actions), React 19.2, Drizzle ORM + drizzle-kit, Postgres, vitest 5 (node environment), zod 4.

**Spec:** `docs/superpowers/specs/2026-09-27-refund-restock-design.md`

## Global Constraints

- **`restocked_quantity` never exceeds `quantity`,** and the bound is enforced in the `UPDATE`'s `WHERE` clause, not by reading first. No row returned means reject the whole transaction. This is the same shape as `markOrderPaid` and it is what makes a double-submitted form safe without a lock.
- **`inventory.reserved` is never touched by a restock.** A committed order has already consumed its reservation; returning units there would make them look spoken-for by an order that no longer exists.
- **`restocked_quantity` is the guard; `inventory_adjustments` is history.** The ledger is never read to decide whether a restock is allowed.
- **The "awaiting a stock decision" state is derived, never stored:** `refunded_cents > 0 AND stock_decision_at IS NULL`. Do not add a boolean flag.
- **`stock_decision_at` records *that* a decision was made, not which one.** Which one is already visible in the per-line `restocked_quantity` values.
- **A restock is refused, not guessed at,** when: the order's `inventory_state` is not `committed`; the order has `refunded_cents = 0`; or every submitted line is zero.
- **Writing off never calls `restockOrderItems`.** It stamps `stock_decision_at` directly.
- **Server Actions repeat `requireAdminUser()`.** The `/admin` layout gates rendering, but an action is reachable by POST without the layout ever rendering. This is stated at `src/app/(admin)/admin/orders/[id]/actions.ts:29-34`.
- Verification commands: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run test:e2e`.
- DB-backed tests need Postgres: `npm run db:test:up` first.

---

### Task 1: Schema and migration

**Files:**
- Modify: `src/lib/db/schema.ts` (the `orders` and `orderItems` tables)
- Create: `drizzle/0008_*.sql` (generated — do not hand-write)

**Interfaces:**
- Consumes: nothing.
- Produces: `orders.stockDecisionAt` (`Date | null`) and `orderItems.restockedQuantity` (`number`, default 0) on the Drizzle types every later task uses.

- [ ] **Step 1: Add the column to `orderItems`**

In `src/lib/db/schema.ts`, the `orderItems` table currently ends with `totalCents`. Add one column after it.

Append to `src/lib/db/schema.ts`:

```ts
    totalCents: integer("total_cents").notNull(),
    // Units returned to stock after a refund. Bounded by `quantity` in the
    // UPDATE that increments it, which is what makes restocking idempotent
    // without a lock -- a resubmitted form cannot inflate stock.
    restockedQuantity: integer("restocked_quantity").notNull().default(0),
```

- [ ] **Step 2: Add the column to `orders`**

In the same file, in the `orders` table, add this immediately after the `refundedCents` line.

Append to `src/lib/db/schema.ts`:

```ts
    // When an admin decided what happens to this order's stock -- set for
    // EITHER decision, restock or write-off. Which one it was is already
    // visible in the per-line restocked_quantity values, so encoding it twice
    // would just create something that can contradict itself.
    //
    // A refunded order with this still null is awaiting a decision. That state
    // is derived from these two columns and is deliberately not stored.
    stockDecisionAt: timestamp("stock_decision_at", { withTimezone: true }),
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0008_<name>.sql` plus an updated `drizzle/meta/_journal.json`.

- [ ] **Step 4: Read the generated SQL before applying it**

Run: `cat drizzle/0008_*.sql`

Expected: exactly two `ALTER TABLE ... ADD COLUMN` statements — `order_items.restocked_quantity integer DEFAULT 0 NOT NULL` and `orders.stock_decision_at timestamp with time zone`.

**Stop and report if it contains anything else** — a `DROP`, a rename, or a change to another table means the schema file drifted from the database and that must be understood before applying.

- [ ] **Step 5: Apply it**

Run: `npm run db:test:up && npm run db:migrate`
Expected: migration applies cleanly.

- [ ] **Step 6: Verify the existing suite still passes**

Run: `npx vitest run`
Expected: all green. A new nullable column and a defaulted integer break nothing; if something fails, the column names collide with something.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/schema.ts drizzle
git commit -m "feat: track restocked units and the refund stock decision

restocked_quantity carries the per-line bound that makes restocking
idempotent. stock_decision_at records that a decision was made at all, so a
refund awaiting one is derivable rather than stored in a flag that can drift."
```

---

### Task 2: The `restockOrderItems` primitive

**Files:**
- Modify: `src/lib/inventory/index.ts`
- Test: `src/lib/inventory/inventory.test.ts` (**append** — this file exists with tests for `reserveStock`, `commitStock`, `releaseStock` and `releaseExpiredReservations`; keep every one of them byte-for-byte)

**Interfaces:**
- Consumes: `orders.stockDecisionAt`, `orderItems.restockedQuantity` from Task 1.
- Produces:
  - `restockOrderItems(tx: Tx, orderId: string, lines: { orderItemId: string; quantity: number }[], adminUserId: string): Promise<void>`
  - `class RestockNotAllowedError extends Error` — thrown for every refusal, with a message safe to show an admin.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/inventory/inventory.test.ts`:

```ts
describe("restockOrderItems", () => {
  /** A paid, committed, refunded order holding `quantity` units. */
  async function refundedOrder(quantity: number) {
    const [order] = await ctx.db
      .insert(orders)
      .values({
        email: "buyer@example.com",
        status: "refunded",
        inventoryState: "committed",
        refundedCents: 5100,
        subtotalCents: 4500,
        shippingCents: 600,
        taxCents: 0,
        discountCents: 0,
        totalCents: 5100,
        shippingAddress: ADDRESS,
      })
      .returning();

    const [item] = await ctx.db
      .insert(orderItems)
      .values({
        orderId: order.id,
        productId,
        name: "Test EDT",
        unitPriceCents: 4500,
        quantity,
        totalCents: 4500 * quantity,
      })
      .returning();

    return { order, item };
  }

  async function stock() {
    const [row] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    return row;
  }

  it("returns units to on_hand and records the movement", async () => {
    const { order, item } = await refundedOrder(2);
    const before = (await stock()).onHand;

    await ctx.db.transaction(async (tx) => {
      await restockOrderItems(
        tx,
        order.id,
        [{ orderItemId: item.id, quantity: 2 }],
        "admin_1",
      );
    });

    expect((await stock()).onHand).toBe(before + 2);

    const [line] = await ctx.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.id, item.id));
    expect(line.restockedQuantity).toBe(2);

    const ledger = await ctx.db
      .select()
      .from(inventoryAdjustments)
      .where(eq(inventoryAdjustments.productId, productId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].delta).toBe(2);
    expect(ledger[0].reason).toBe("refund_restock");
    expect(ledger[0].adminUserId).toBe("admin_1");
  });

  it("never returns more units than were ordered", async () => {
    const { order, item } = await refundedOrder(2);
    const before = (await stock()).onHand;

    await expect(
      ctx.db.transaction(async (tx) => {
        await restockOrderItems(
          tx,
          order.id,
          [{ orderItemId: item.id, quantity: 3 }],
          "admin_1",
        );
      }),
    ).rejects.toThrow(RestockNotAllowedError);

    // The whole transaction rolled back: no stock, no ledger row.
    expect((await stock()).onHand).toBe(before);
    expect(
      await ctx.db.select().from(inventoryAdjustments),
    ).toHaveLength(0);
  });

  it("returns the units once when the same restock is submitted twice", async () => {
    const { order, item } = await refundedOrder(2);
    const before = (await stock()).onHand;

    const restock = () =>
      ctx.db.transaction(async (tx) => {
        await restockOrderItems(
          tx,
          order.id,
          [{ orderItemId: item.id, quantity: 2 }],
          "admin_1",
        );
      });

    await restock();
    await expect(restock()).rejects.toThrow(RestockNotAllowedError);

    expect((await stock()).onHand).toBe(before + 2);
  });

  it("allows a later return of the remaining unit", async () => {
    const { order, item } = await refundedOrder(2);
    const before = (await stock()).onHand;

    for (const quantity of [1, 1]) {
      await ctx.db.transaction(async (tx) => {
        await restockOrderItems(
          tx,
          order.id,
          [{ orderItemId: item.id, quantity }],
          "admin_1",
        );
      });
    }

    expect((await stock()).onHand).toBe(before + 2);
    expect(await ctx.db.select().from(inventoryAdjustments)).toHaveLength(2);
  });

  it("leaves reserved untouched", async () => {
    const { order, item } = await refundedOrder(2);
    const before = (await stock()).reserved;

    await ctx.db.transaction(async (tx) => {
      await restockOrderItems(
        tx,
        order.id,
        [{ orderItemId: item.id, quantity: 1 }],
        "admin_1",
      );
    });

    // Restocking returns units to the available pool, not to a reservation --
    // this order's reservation was consumed when its stock was committed.
    expect((await stock()).reserved).toBe(before);
  });

  it("refuses an order whose stock was never committed", async () => {
    const { order, item } = await refundedOrder(1);
    await ctx.db
      .update(orders)
      .set({ inventoryState: "released" })
      .where(eq(orders.id, order.id));

    await expect(
      ctx.db.transaction(async (tx) => {
        await restockOrderItems(
          tx,
          order.id,
          [{ orderItemId: item.id, quantity: 1 }],
          "admin_1",
        );
      }),
    ).rejects.toThrow(RestockNotAllowedError);
  });

  it("refuses an order with no refund recorded", async () => {
    const { order, item } = await refundedOrder(1);
    await ctx.db
      .update(orders)
      .set({ refundedCents: 0 })
      .where(eq(orders.id, order.id));

    await expect(
      ctx.db.transaction(async (tx) => {
        await restockOrderItems(
          tx,
          order.id,
          [{ orderItemId: item.id, quantity: 1 }],
          "admin_1",
        );
      }),
    ).rejects.toThrow(RestockNotAllowedError);
  });

  it("refuses a submission of nothing", async () => {
    const { order, item } = await refundedOrder(1);

    await expect(
      ctx.db.transaction(async (tx) => {
        await restockOrderItems(
          tx,
          order.id,
          [{ orderItemId: item.id, quantity: 0 }],
          "admin_1",
        );
      }),
    ).rejects.toThrow(RestockNotAllowedError);
  });

  it("refuses a line belonging to a different order", async () => {
    const mine = await refundedOrder(1);
    const theirs = await refundedOrder(1);

    await expect(
      ctx.db.transaction(async (tx) => {
        await restockOrderItems(
          tx,
          mine.order.id,
          [{ orderItemId: theirs.item.id, quantity: 1 }],
          "admin_1",
        );
      }),
    ).rejects.toThrow(RestockNotAllowedError);
  });
});
```

Add the new imports the tests need. The file already imports `products, inventory, orders, orderItems` from `@/lib/db/schema` and several functions from `./index` — extend both import lists rather than adding new statements:

```ts
import {
  products,
  inventory,
  orders,
  orderItems,
  inventoryAdjustments,
} from "@/lib/db/schema";
import {
  reserveStock,
  commitStock,
  releaseStock,
  releaseExpiredReservations,
  restockOrderItems,
  OutOfStockError,
  RestockNotAllowedError,
} from "./index";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/inventory/inventory.test.ts`
Expected: FAIL — `restockOrderItems is not a function` (and `RestockNotAllowedError` undefined).

- [ ] **Step 3: Implement it**

In `src/lib/inventory/index.ts`, add `inventoryAdjustments` to the existing schema import:

```ts
import {
  inventory,
  inventoryAdjustments,
  orders,
  orderItems,
} from "@/lib/db/schema";
```

Append to `src/lib/inventory/index.ts`:

```ts
export class RestockNotAllowedError extends Error {
  constructor(reason: string) {
    super(`Cannot restock this order: ${reason}`);
    this.name = "RestockNotAllowedError";
  }
}

/**
 * Returns refunded units to the available pool.
 *
 * Refunding an order used to move money and nothing else, so every refund
 * quietly destroyed stock on paper: `commitStock` had already decremented
 * `on_hand`, and nothing ever added it back.
 *
 * The bound lives in the WHERE clause, like `reserveStock`'s. That single
 * atomic statement is the whole idempotency story -- a double-submitted form
 * or two admins clicking at once cannot inflate stock, and no lock is needed.
 * Unlike a state-machine claim it still allows a LATER return of whatever is
 * left, which is the second-bottle-comes-back-next-week case.
 *
 * `reserved` is deliberately untouched: this order's reservation was consumed
 * when its stock was committed, and putting units back there would make them
 * look spoken-for by an order that no longer exists.
 *
 * Must be called inside a transaction: a failure on any line must roll back
 * the lines already restocked, or a partial failure leaves invented stock.
 */
export async function restockOrderItems(
  tx: Tx,
  orderId: string,
  lines: { orderItemId: string; quantity: number }[],
  adminUserId: string,
): Promise<void> {
  const requested = lines.filter((line) => line.quantity > 0);
  if (requested.length === 0) {
    throw new RestockNotAllowedError(
      "no units were entered — write the order off instead if nothing came back",
    );
  }

  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) {
    throw new RestockNotAllowedError("no such order");
  }

  // Units that were never deducted cannot be returned; doing so would invent
  // stock out of nothing.
  if (order.inventoryState !== "committed") {
    throw new RestockNotAllowedError(
      `its stock was never committed (inventory state "${order.inventoryState}")`,
    );
  }

  if (order.refundedCents <= 0) {
    throw new RestockNotAllowedError("it has no refund recorded");
  }

  for (const line of requested) {
    const claimed = await tx
      .update(orderItems)
      .set({
        restockedQuantity: sql`${orderItems.restockedQuantity} + ${line.quantity}`,
      })
      .where(
        and(
          eq(orderItems.id, line.orderItemId),
          // Scoping to the order stops a line from another order being
          // restocked through this one.
          eq(orderItems.orderId, orderId),
          sql`${orderItems.restockedQuantity} + ${line.quantity} <= ${orderItems.quantity}`,
        ),
      )
      .returning({ productId: orderItems.productId });

    if (claimed.length === 0) {
      throw new RestockNotAllowedError(
        "that is more than was ordered, or the line is not on this order",
      );
    }

    await tx
      .update(inventory)
      .set({
        onHand: sql`${inventory.onHand} + ${line.quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(inventory.productId, claimed[0].productId));

    await tx.insert(inventoryAdjustments).values({
      productId: claimed[0].productId,
      delta: line.quantity,
      reason: "refund_restock",
      adminUserId,
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/inventory/inventory.test.ts`
Expected: PASS, including every pre-existing test in the file. If the file now contains only your new `describe`, you have overwritten it — recover with `git show HEAD:src/lib/inventory/inventory.test.ts`.

- [ ] **Step 5: Mutation-test the bound**

This is the point of the whole task, so prove the guard is load-bearing rather than assuming it.

Temporarily delete this line from the `.where(and(...))` in `restockOrderItems`:

```ts
          sql`${orderItems.restockedQuantity} + ${line.quantity} <= ${orderItems.quantity}`,
```

Run: `npx vitest run src/lib/inventory/inventory.test.ts`
Expected: FAIL — "never returns more units than were ordered" and "returns the units once when the same restock is submitted twice".

**Then restore the line** and re-run to confirm green. Report both results. If either test still passed with the bound removed, the test is not protecting the invariant and must be fixed before moving on.

- [ ] **Step 6: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/inventory/index.ts src/lib/inventory/inventory.test.ts
git commit -m "feat: return refunded units to stock

The bound lives in the UPDATE's WHERE clause, so a resubmitted form cannot
inflate stock and no lock is needed. Verified load-bearing: removing it fails
the over-restock and double-submit tests."
```

---

### Task 3: The order-level restock and write-off

**Files:**
- Create: `src/lib/orders/restock.ts`
- Test: `src/lib/orders/restock.test.ts`

**Interfaces:**
- Consumes: `restockOrderItems`, `RestockNotAllowedError` from Task 2.
- Produces:
  - `restockRefundedOrder(args: { orderId: string; lines: { orderItemId: string; quantity: number }[]; adminUserId: string }): Promise<void>`
  - `writeOffOrderStock(args: { orderId: string }): Promise<void>` — no admin id, because nothing here records one
  - `awaitsStockDecision(order: Order): boolean`

Note the import path for `completePaidOrder`-style siblings: this module imports `db` from `@/lib/db/client` directly, not through `@/lib/orders`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/orders/restock.test.ts`:

```ts
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { products, inventory, orders, orderItems } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
let productId: string;

// restock.ts imports `db` at module scope, so without this the module under
// test would talk to the dev database instead of the test one. The dynamic
// import below is what keeps the module load AFTER this mock is registered.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US" as const,
};

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  const [product] = await ctx.db
    .insert(products)
    .values({
      slug: "test-edt",
      name: "Test EDT",
      description: "Test",
      priceCents: 4500,
      sku: "T-1",
    })
    .returning();
  productId = product.id;
  await ctx.db.insert(inventory).values({ productId, onHand: 10 });
});

const { restockRefundedOrder, writeOffOrderStock, awaitsStockDecision } =
  await import("./restock");

async function refundedOrder(quantity: number) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      status: "refunded",
      inventoryState: "committed",
      refundedCents: 5100,
      subtotalCents: 4500,
      shippingCents: 600,
      taxCents: 0,
      discountCents: 0,
      totalCents: 5100,
      shippingAddress: ADDRESS,
    })
    .returning();

  const [item] = await ctx.db
    .insert(orderItems)
    .values({
      orderId: order.id,
      productId,
      name: "Test EDT",
      unitPriceCents: 4500,
      quantity,
      totalCents: 4500 * quantity,
    })
    .returning();

  return { order, item };
}

async function reload(orderId: string) {
  const [row] = await ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId));
  return row;
}

describe("restockRefundedOrder", () => {
  it("returns the units and records the decision", async () => {
    const { order, item } = await refundedOrder(2);

    await restockRefundedOrder({
      orderId: order.id,
      lines: [{ orderItemId: item.id, quantity: 2 }],
      adminUserId: "admin_1",
    });

    const [stock] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    expect(stock.onHand).toBe(12);
    expect((await reload(order.id)).stockDecisionAt).not.toBeNull();
  });

  it("records no decision when the restock is rejected", async () => {
    const { order, item } = await refundedOrder(1);

    await expect(
      restockRefundedOrder({
        orderId: order.id,
        lines: [{ orderItemId: item.id, quantity: 5 }],
        adminUserId: "admin_1",
      }),
    ).rejects.toThrow();

    // The stamp and the stock move together or not at all: an order marked
    // decided with nothing restocked would drop off the pending list while
    // the units stayed lost.
    expect((await reload(order.id)).stockDecisionAt).toBeNull();
    const [stock] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    expect(stock.onHand).toBe(10);
  });
});

describe("writeOffOrderStock", () => {
  it("records the decision and changes no stock", async () => {
    const { order } = await refundedOrder(2);

    await writeOffOrderStock({ orderId: order.id });

    expect((await reload(order.id)).stockDecisionAt).not.toBeNull();
    const [stock] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    expect(stock.onHand).toBe(10);
  });

  it("refuses an order with no refund", async () => {
    const { order } = await refundedOrder(1);
    await ctx.db
      .update(orders)
      .set({ refundedCents: 0 })
      .where(eq(orders.id, order.id));

    await expect(
      writeOffOrderStock({ orderId: order.id }),
    ).rejects.toThrow();

    // The damage a missing guard would do is deferred, not immediate: stamping
    // an unrefunded order changes nothing today, but the order could never
    // surface as awaiting a decision after a later refund.
    expect((await reload(order.id)).stockDecisionAt).toBeNull();
  });
});

describe("awaitsStockDecision", () => {
  it("is true for a refunded order with no decision", async () => {
    const { order } = await refundedOrder(1);
    expect(awaitsStockDecision(order)).toBe(true);
  });

  it("is false once a decision is recorded", async () => {
    const { order } = await refundedOrder(1);
    await writeOffOrderStock({ orderId: order.id });
    expect(awaitsStockDecision(await reload(order.id))).toBe(false);
  });

  it("is false for an order that was never refunded", async () => {
    const { order } = await refundedOrder(1);
    await ctx.db
      .update(orders)
      .set({ refundedCents: 0 })
      .where(eq(orders.id, order.id));
    expect(awaitsStockDecision(await reload(order.id))).toBe(false);
  });
});
```

The `vi.mock` plus the dynamic `await import("./restock")` is the pattern from `src/lib/orders/reuse.test.ts:15-22`, and both halves are required. A static `import` at the top would load the real database client before the mock registered, and the suite would quietly write to the dev database.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/orders/restock.test.ts`
Expected: FAIL — cannot resolve `./restock`.

- [ ] **Step 3: Implement it**

Create `src/lib/orders/restock.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, type Order } from "@/lib/db/schema";
import { restockOrderItems, RestockNotAllowedError } from "@/lib/inventory";

/**
 * Whether this order is waiting for someone to say what happened to its stock.
 *
 * Derived rather than stored. A boolean column would be a second source of
 * truth for something these two fields already answer, and the two could
 * disagree.
 */
export function awaitsStockDecision(order: Order): boolean {
  return order.refundedCents > 0 && order.stockDecisionAt === null;
}

/**
 * Returns units from a refunded order to stock and records that the decision
 * was made.
 *
 * Both happen in one transaction on purpose. An order stamped as decided with
 * nothing actually restocked would vanish from the pending list while its
 * units stayed lost -- the silent-drift failure this feature exists to end.
 */
export async function restockRefundedOrder(args: {
  orderId: string;
  lines: { orderItemId: string; quantity: number }[];
  adminUserId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await restockOrderItems(tx, args.orderId, args.lines, args.adminUserId);

    await tx
      .update(orders)
      .set({ stockDecisionAt: new Date() })
      .where(eq(orders.id, args.orderId));
  });
}

/**
 * Records that the goods are not coming back, without touching stock.
 *
 * Deliberately does not call restockOrderItems: there is nothing to restock,
 * and routing a zero through it would hit the "no units were entered" refusal.
 *
 * Takes no admin id because nothing here records one -- stock_decision_at
 * stores that a decision happened, not who made it, and the ledger only gets
 * rows for actual stock movements. Add attribution when there is a column to
 * put it in, not a parameter that goes nowhere.
 */
export async function writeOffOrderStock(args: {
  orderId: string;
}): Promise<void> {
  // Refuse when there is no refund to decide about. Without this, stamping an
  // unrefunded order looks harmless -- awaitsStockDecision already returns
  // false for it -- but it poisons the future: refund that order later and it
  // will never surface as awaiting a decision, so its units go back to nobody
  // and nothing says so. That is the silent drift this feature exists to end,
  // reintroduced through the back door.
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, args.orderId))
    .limit(1);

  if (!order) {
    throw new RestockNotAllowedError("no such order");
  }

  if (order.refundedCents <= 0) {
    throw new RestockNotAllowedError("it has no refund recorded");
  }

  await db
    .update(orders)
    .set({ stockDecisionAt: new Date() })
    .where(eq(orders.id, args.orderId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/orders/restock.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/orders/restock.ts src/lib/orders/restock.test.ts
git commit -m "feat: record the stock decision alongside the restock

The stamp and the units move in one transaction: an order marked decided with
nothing restocked would leave the pending list while the stock stayed lost."
```

---

### Task 4: Admin server actions

**Files:**
- Modify: `src/app/(admin)/admin/orders/[id]/actions.ts`
- Test: `src/app/(admin)/admin/orders/[id]/restockAction.test.ts`

**Interfaces:**
- Consumes: `restockRefundedOrder`, `writeOffOrderStock` from Task 3; `RestockNotAllowedError` from Task 2.
- Produces: `restockAction`, `writeOffAction`, and `type StockState` for Task 5's form.

- [ ] **Step 1: Write the failing test**

Read `src/app/(admin)/admin/orders/[id]/refundAction.test.ts` first and copy its mocking of `requireAdminUser` exactly — that is how this suite authenticates, and inventing a different approach here will diverge from the rest of the admin tests.

Add a new file at `src/app/(admin)/admin/orders/[id]/restockAction.test.ts`. Copy the whole harness from `src/lib/orders/restock.test.ts` (Task 3, Step 1) — the imports, the `vi.mock` of `@/lib/db/client`, `beforeAll`/`afterAll`/`beforeEach`, the `ADDRESS` constant and the `refundedOrder` helper — then import the actions dynamically the same way and add the tests below.

(This step deliberately avoids the `Create \`path\`:` heading syntax: the drift guard parses those and compares them byte for byte against the shipped file, and the block below is a fragment rather than a whole file. Writing it as a `Create` block would guarantee a guard failure in Task 6.)

```ts
describe("restockAction", () => {
  it("restocks the submitted quantities", async () => {
    const { order, item } = await refundedOrder(2);

    const form = new FormData();
    form.set("orderId", order.id);
    form.set(`quantity:${item.id}`, "2");

    const state = await restockAction({ status: "idle" }, form);

    expect(state).toEqual({ status: "restocked", units: 2 });
    const [stock] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    expect(stock.onHand).toBe(12);
  });

  it("reports a refusal instead of throwing", async () => {
    const { order, item } = await refundedOrder(1);

    const form = new FormData();
    form.set("orderId", order.id);
    form.set(`quantity:${item.id}`, "9");

    const state = await restockAction({ status: "idle" }, form);

    expect(state.status).toBe("error");
  });

  it("rejects an order with no refund", async () => {
    const { order, item } = await refundedOrder(1);
    await ctx.db
      .update(orders)
      .set({ refundedCents: 0 })
      .where(eq(orders.id, order.id));

    const form = new FormData();
    form.set("orderId", order.id);
    form.set(`quantity:${item.id}`, "1");

    expect((await restockAction({ status: "idle" }, form)).status).toBe("error");
  });
});

describe("writeOffAction", () => {
  it("records the decision without touching stock", async () => {
    const { order } = await refundedOrder(2);

    const form = new FormData();
    form.set("orderId", order.id);

    const state = await writeOffAction({ status: "idle" }, form);

    expect(state).toEqual({ status: "written-off" });
    const [stock] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    expect(stock.onHand).toBe(10);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "src/app/(admin)/admin/orders/[id]/restockAction.test.ts"`
Expected: FAIL — `restockAction` is not exported.

- [ ] **Step 3: Implement the actions**

Add to the imports at the top of `src/app/(admin)/admin/orders/[id]/actions.ts`:

```ts
import { restockRefundedOrder, writeOffOrderStock } from "@/lib/orders/restock";
import { RestockNotAllowedError } from "@/lib/inventory";
```

Append to `src/app/(admin)/admin/orders/[id]/actions.ts`:

```ts
export type StockState =
  | { status: "idle" }
  | { status: "restocked"; units: number }
  | { status: "written-off" }
  | { status: "error"; error: string };

/**
 * Quantities arrive as `quantity:<orderItemId>` fields, so the form can carry
 * one input per line without the action needing to know the lines in advance.
 */
function parseLines(formData: FormData) {
  const lines: { orderItemId: string; quantity: number }[] = [];

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("quantity:")) continue;

    const quantity = Number(value);
    // A non-numeric or negative entry is a broken form, not a request to
    // remove stock -- refuse rather than quietly coercing it to zero.
    if (!Number.isInteger(quantity) || quantity < 0) return null;

    lines.push({ orderItemId: key.slice("quantity:".length), quantity });
  }

  return lines;
}

export async function restockAction(
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  const admin = await requireAdminUser();

  const orderId = z.uuid().safeParse(formData.get("orderId"));
  if (!orderId.success) {
    return { status: "error", error: "Unknown order." };
  }

  const lines = parseLines(formData);
  if (!lines) {
    return { status: "error", error: "Enter whole numbers of units." };
  }

  try {
    await restockRefundedOrder({
      orderId: orderId.data,
      lines,
      adminUserId: admin.id,
    });
  } catch (error) {
    if (error instanceof RestockNotAllowedError) {
      return { status: "error", error: error.message };
    }
    throw error;
  }

  revalidatePath(`/admin/orders/${orderId.data}`);
  revalidatePath("/admin/orders");

  const units = lines.reduce((total, line) => total + line.quantity, 0);
  return { status: "restocked", units };
}

export async function writeOffAction(
  _prev: StockState,
  formData: FormData,
): Promise<StockState> {
  await requireAdminUser();

  const orderId = z.uuid().safeParse(formData.get("orderId"));
  if (!orderId.success) {
    return { status: "error", error: "Unknown order." };
  }

  await writeOffOrderStock({ orderId: orderId.data });

  revalidatePath(`/admin/orders/${orderId.data}`);
  revalidatePath("/admin/orders");

  return { status: "written-off" };
}
```

`requireAdminUser()` returns a `SessionUser` (`src/lib/auth/session.ts:5-10`) whose `id` is a string — that is the value `inventory_adjustments.admin_user_id` records. Note `restockAction` above calls it twice; collapse that to a single `const admin = await requireAdminUser();` at the top, matching `writeOffAction`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "src/app/(admin)/admin/orders/[id]/restockAction.test.ts"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(admin)/admin/orders/[id]/actions.ts" "src/app/(admin)/admin/orders/[id]/restockAction.test.ts"
git commit -m "feat: admin actions to restock or write off refunded stock"
```

---

### Task 5: The Stock panel and the pending marker

**Files:**
- Create: `src/app/(admin)/admin/orders/[id]/StockPanel.tsx`
- Modify: `src/app/(admin)/admin/orders/[id]/page.tsx`
- Modify: `src/app/(admin)/admin/orders/page.tsx`

**Interfaces:**
- Consumes: `restockAction`, `writeOffAction`, `StockState` from Task 4; `awaitsStockDecision` from Task 3.
- Produces: nothing.

- [ ] **Step 1: Build the panel**

Create `src/app/(admin)/admin/orders/[id]/StockPanel.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { restockAction, writeOffAction, type StockState } from "./actions";
import { Button } from "@/components/ui/Button";
// Same stylesheet the order detail page uses, so this table lines up with the
// Items table above it instead of rendering as an unstyled block.
import styles from "./detail.module.css";

type Line = {
  id: string;
  name: string;
  quantity: number;
  restockedQuantity: number;
};

/**
 * What happens to the stock of a refunded order.
 *
 * Refunding returns money; whether the goods come back is a separate question
 * only a human can answer -- an unshipped order is resalable, an opened bottle
 * is not. So this asks rather than inferring, and a refund with no answer yet
 * stays visible instead of silently deciding nothing.
 */
export function StockPanel({
  orderId,
  lines,
  decided,
}: {
  orderId: string;
  lines: Line[];
  decided: boolean;
}) {
  const [reopened, setReopened] = useState(false);
  const [state, action, pending] = useActionState<StockState, FormData>(
    restockAction,
    { status: "idle" },
  );

  const remaining = lines.reduce(
    (total, line) => total + (line.quantity - line.restockedQuantity),
    0,
  );

  if (state.status === "restocked") {
    return <p role="status">{state.units} returned to stock.</p>;
  }

  if (decided && !reopened) {
    const restocked = lines.reduce(
      (total, line) => total + line.restockedQuantity,
      0,
    );

    return (
      <div>
        <p>
          {restocked > 0
            ? `${restocked} returned to stock.`
            : "Written off. Stock unchanged."}
        </p>
        {remaining > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setReopened(true)}
          >
            Restock more
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      <form action={action}>
        <input type="hidden" name="orderId" value={orderId} />

        <table className={styles.table}>
          <thead>
            <tr>
              <th>Item</th>
              <th className={styles.right}>Ordered</th>
              <th className={styles.right}>Already restocked</th>
              <th className={styles.right}>Return to stock</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.name}</td>
                <td className={styles.right}>{line.quantity}</td>
                <td className={styles.right}>{line.restockedQuantity}</td>
                <td className={styles.right}>
                  <input
                    type="number"
                    name={`quantity:${line.id}`}
                    min={0}
                    max={line.quantity - line.restockedQuantity}
                    defaultValue={line.quantity - line.restockedQuantity}
                    aria-label={`Units of ${line.name} to return to stock`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {state.status === "error" && <p role="alert">{state.error}</p>}

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Returning" : "Return to stock"}
        </Button>
      </form>

      <WriteOffForm orderId={orderId} />
    </>
  );
}

/**
 * Its own form and its own action state.
 *
 * `formAction={writeOffAction}` on a button inside the restock form does NOT
 * work: useActionState actions take (prevState, formData), so React would pass
 * FormData as prevState and nothing as formData. Two forms is the shape the
 * rest of this directory already uses -- see ResendPrompt in FulfillForm.tsx.
 */
function WriteOffForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState<StockState, FormData>(
    writeOffAction,
    { status: "idle" },
  );

  if (state.status === "written-off") {
    return <p role="status">Written off. Stock unchanged.</p>;
  }

  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      {state.status === "error" && <p role="alert">{state.error}</p>}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Saving" : "Write off"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Render it on the order page**

In `src/app/(admin)/admin/orders/[id]/page.tsx`, add the import beside the existing `RefundButton` import:

```tsx
import { StockPanel } from "./StockPanel";
```

Render it immediately after the block containing `<RefundButton .../>`:

```tsx
      {order.refundedCents > 0 && (
        <section>
          <h2>Stock</h2>
          <StockPanel
            orderId={order.id}
            decided={order.stockDecisionAt !== null}
            lines={order.items.map((item) => ({
              id: item.id,
              name: item.name,
              quantity: item.quantity,
              restockedQuantity: item.restockedQuantity,
            }))}
          />
        </section>
      )}
```

- [ ] **Step 3: Mark pending orders in the list**

In `src/app/(admin)/admin/orders/page.tsx`, add the import:

```tsx
import { awaitsStockDecision } from "@/lib/orders/restock";
```

Replace the order-number cell in the `rows.map` body. It currently reads:

```tsx
                <td>
                  <Link href={`/admin/orders/${order.id}`}>
                    {formatOrderNumber(order.orderNumber)}
                  </Link>
                </td>
```

with:

```tsx
                <td>
                  <Link href={`/admin/orders/${order.id}`}>
                    {formatOrderNumber(order.orderNumber)}
                  </Link>
                  {awaitsStockDecision(order) && (
                    <span title="Refunded — awaiting a stock decision"> ⏳</span>
                  )}
                </td>
```

Note the map variable is `order`, not `row`.

`listOrdersForAdmin` already does `select()` over the whole `orders` row, so `refundedCents` and `stockDecisionAt` are present with no query change.

- [ ] **Step 4: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean. If `order.items[].restockedQuantity` does not type-check, `findOrderById` is not selecting the new column — widen its select rather than casting.

- [ ] **Step 5: Check it in the running app**

Start the dev server, create the state by hand in the dev database (a paid order with `inventory_state = 'committed'` and `refunded_cents > 0`), and load `/admin/orders/<id>`.

Confirm: the Stock panel appears; the quantity defaults to the full ordered amount; *Return to stock* raises `on_hand`; the panel collapses to a summary; the list shows the marker before the decision and not after.

Report what you saw. Reading the code is not this step.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(admin)/admin/orders/[id]/StockPanel.tsx" "src/app/(admin)/admin/orders/[id]/page.tsx" "src/app/(admin)/admin/orders/page.tsx"
git commit -m "feat: ask what happens to stock when an order is refunded"
```

---

### Task 6: Register the plan and verify the whole change

**Files:**
- Modify: `src/test/plan-drift.test.ts` (the `PLANS` array)

**Interfaces:**
- Consumes: every file changed in Tasks 1-5.
- Produces: nothing.

- [ ] **Step 1: Register this plan with the guard**

`src/test/plan-drift.test.ts` compares every `Create` block in a registered plan byte for byte against the shipped file. An unregistered plan is silently unguarded, which is the state that test exists to prevent.

Add one entry to the `PLANS` array, after the existing entries.

Append to `src/test/plan-drift.test.ts`:

```ts
  "docs/superpowers/plans/2026-09-27-refund-restock.md",
```

- [ ] **Step 2: Run the guard**

Run: `npx vitest run src/test/plan-drift.test.ts`

Expected: it will likely FAIL, naming `src/lib/orders/restock.ts` and `src/app/(admin)/admin/orders/[id]/StockPanel.tsx` — the two `Create` blocks in this plan. Any deviation an earlier task made (a different comment, a rename) shows up here.

For each failure, decide which side is right: if the shipped code is correct, update this plan's code block to match it. **Do not weaken the test, and do not add `plan-drift: partial` markers to dodge a comparison.**

- [ ] **Step 3: Run the guard again**

Run: `npx vitest run src/test/plan-drift.test.ts`
Expected: PASS.

- [ ] **Step 4: Full verification**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run test:e2e`
Expected: all green.

The payment e2e (`a guest can buy a bottle`) self-skips unless a `stripe listen` is forwarding webhooks. **A skip means it did not run.** To exercise it:

```bash
STRIPE_API_KEY="$STRIPE_SECRET_KEY" stripe listen \
  --events payment_intent.succeeded,payment_intent.payment_failed,charge.refunded \
  --forward-to localhost:3000/api/stripe/webhook
```

Pass the key via `STRIPE_API_KEY` in the environment rather than `--api-key`, so it stays out of `ps` — the e2e's own skip guard reads `ps -ax -o args=`. Note CLI 1.51 requires `--events`; a bare `stripe listen` exits 1.

Report which of the two happened. A skipped test is not evidence.

- [ ] **Step 5: Commit**

```bash
git add src/test/plan-drift.test.ts docs/superpowers/plans
git commit -m "docs: bring the refund restock plan under the drift guard"
```

---

## Success criteria

- Refunding an order and choosing *Return to stock* raises `on_hand` by exactly the units chosen, and writes one `inventory_adjustments` row per line naming the acting admin.
- Choosing *Write off* changes no stock and clears the pending marker.
- A refund issued from the Stripe dashboard shows as awaiting a decision and changes no stock until an admin acts.
- A restock cannot return more units than were ordered under any sequence of submissions, and removing the bound from the `UPDATE` fails a test.
- A partially restocked order can be restocked again later, up to the remainder.
- `npm test`, `npx tsc --noEmit`, `npm run lint` and `npm run test:e2e` are green, with the plan registered in the drift guard.
