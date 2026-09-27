import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testDb } from "@/test/db";
import {
  products,
  inventory,
  orders,
  orderItems,
  inventoryAdjustments,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  reserveStock,
  commitStock,
  releaseStock,
  releaseExpiredReservations,
  restockOrderItems,
  OutOfStockError,
  RestockNotAllowedError,
} from "./index";

let ctx: Awaited<ReturnType<typeof testDb>>;
let productId: string;

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
  await ctx.db
    .insert(inventory)
    .values({ productId, onHand: 2, reserved: 0 });
});

async function createOrder(quantity: number) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      subtotalCents: 4500 * quantity,
      totalCents: 4500 * quantity,
      shippingAddress: ADDRESS,
    })
    .returning();

  await ctx.db.insert(orderItems).values({
    orderId: order.id,
    productId,
    name: "Test EDT",
    unitPriceCents: 4500,
    quantity,
    totalCents: 4500 * quantity,
  });

  return order.id;
}

async function stock() {
  const [row] = await ctx.db
    .select()
    .from(inventory)
    .where(eq(inventory.productId, productId));
  return row;
}

describe("reserveStock", () => {
  it("increments reserved without changing onHand", async () => {
    await ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 1 }]));
    expect(await stock()).toMatchObject({ onHand: 2, reserved: 1 });
  });

  it("allows reserving all available stock", async () => {
    await ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 2 }]));
    expect(await stock()).toMatchObject({ onHand: 2, reserved: 2 });
  });

  it("throws OutOfStockError when requesting more than available", async () => {
    await expect(
      ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 3 }])),
    ).rejects.toBeInstanceOf(OutOfStockError);
  });

  it("leaves stock untouched when a multi-line reservation fails", async () => {
    await expect(
      ctx.db.transaction((tx) =>
        reserveStock(tx, [
          { productId, quantity: 1 },
          { productId, quantity: 5 },
        ]),
      ),
    ).rejects.toBeInstanceOf(OutOfStockError);

    // The whole transaction rolled back — no partial reservation survived.
    expect(await stock()).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it("lets exactly one of two concurrent buyers take the last unit", async () => {
    await ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 1 }]));

    const results = await Promise.allSettled([
      ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 1 }])),
      ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 1 }])),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await stock()).toMatchObject({ onHand: 2, reserved: 2 });
  });

  // The two-buyer test above relies on incidental event-loop interleaving to
  // create overlap. It's stable in practice, but a naive read-then-write
  // implementation could theoretically pass if the two transactions happened
  // to serialize. Raising the contention (12 racers over 5 units) makes
  // serialization vanishingly unlikely, so this asserts the invariant that
  // actually matters: never more reservations than stock, under real load.
  it("never reserves more than stock exists under high contention", async () => {
    await ctx.db
      .update(inventory)
      .set({ onHand: 5 })
      .where(eq(inventory.productId, productId));

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 1 }])),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof OutOfStockError,
    );

    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(7);
    expect(await stock()).toMatchObject({ onHand: 5, reserved: 5 });
  });
});

describe("commitStock", () => {
  it("decrements onHand and reserved together", async () => {
    const orderId = await createOrder(1);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 1 }]);
      await tx
        .update(orders)
        .set({ inventoryState: "reserved" })
        .where(eq(orders.id, orderId));
    });

    await ctx.db.transaction((tx) => commitStock(tx, orderId));
    expect(await stock()).toMatchObject({ onHand: 1, reserved: 0 });
  });

  it("is idempotent — a replayed webhook decrements once", async () => {
    const orderId = await createOrder(1);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 1 }]);
      await tx
        .update(orders)
        .set({ inventoryState: "reserved" })
        .where(eq(orders.id, orderId));
    });

    await ctx.db.transaction((tx) => commitStock(tx, orderId));
    await ctx.db.transaction((tx) => commitStock(tx, orderId));

    expect(await stock()).toMatchObject({ onHand: 1, reserved: 0 });
  });
});

describe("releaseStock", () => {
  it("returns reserved units without touching onHand", async () => {
    const orderId = await createOrder(2);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 2 }]);
      await tx
        .update(orders)
        .set({ inventoryState: "reserved" })
        .where(eq(orders.id, orderId));
    });

    await ctx.db.transaction((tx) => releaseStock(tx, orderId));
    expect(await stock()).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it("is idempotent", async () => {
    const orderId = await createOrder(1);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 1 }]);
      await tx
        .update(orders)
        .set({ inventoryState: "reserved" })
        .where(eq(orders.id, orderId));
    });

    await ctx.db.transaction((tx) => releaseStock(tx, orderId));
    await ctx.db.transaction((tx) => releaseStock(tx, orderId));

    expect(await stock()).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it("does not release an order that was already committed", async () => {
    const orderId = await createOrder(1);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 1 }]);
      await tx
        .update(orders)
        .set({ inventoryState: "reserved" })
        .where(eq(orders.id, orderId));
    });

    await ctx.db.transaction((tx) => commitStock(tx, orderId));
    await ctx.db.transaction((tx) => releaseStock(tx, orderId));

    expect(await stock()).toMatchObject({ onHand: 1, reserved: 0 });
  });
});

describe("releaseExpiredReservations", () => {
  it("does not cancel an order the webhook already marked paid mid-sweep", async () => {
    const orderId = await createOrder(1);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 1 }]);
      await tx
        .update(orders)
        .set({
          inventoryState: "reserved",
          reservationExpiresAt: new Date(Date.now() - 1000),
        })
        .where(eq(orders.id, orderId));
    });

    // Force a real overlap rather than hoping for incidental interleaving:
    // hold the webhook's transaction open after it writes (commit + paid)
    // but before it commits. The sweep's outer SELECT is a separate read, so
    // under READ COMMITTED it still sees the pre-webhook committed state
    // (pending/reserved) and picks the order up as a candidate. The sweep's
    // per-order UPDATE then contends for the same row the webhook already
    // holds a lock on, blocks until the webhook commits, and — per Postgres's
    // EvalPlanQual re-evaluation — re-checks its WHERE clause against the
    // now-committed row and finds it no longer matches "reserved". This
    // reproduces the production race deterministically.
    let releaseHold: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let webhookReady: () => void;
    const webhookIsReady = new Promise<void>((resolve) => {
      webhookReady = resolve;
    });

    const webhookPromise = ctx.db.transaction(async (tx) => {
      await commitStock(tx, orderId);
      await tx
        .update(orders)
        .set({ status: "paid" })
        .where(eq(orders.id, orderId));
      webhookReady();
      await held;
    });

    await webhookIsReady;
    const releasePromise = releaseExpiredReservations(ctx.db);
    // Give the sweep's outer SELECT (and its per-order transaction's UPDATE
    // attempt, which will now block on the webhook's row lock) time to reach
    // Postgres before we let the webhook commit. This is not a race we're
    // hoping to win — the webhook is held open deterministically until we
    // call releaseHold(); the delay just guarantees the sweep's read happens
    // against the pre-commit (still pending) snapshot instead of depending on
    // which of two just-dispatched network requests the driver flushes first.
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseHold!();
    const [cancelledCount] = await Promise.all([releasePromise, webhookPromise]);

    const [order] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));

    expect(order.status).toBe("paid");
    expect(cancelledCount).toBe(0);
    expect(await stock()).toMatchObject({ onHand: 1, reserved: 0 });
  });
});

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
    // Seeded non-zero: starting from 0, this assertion could not tell
    // "untouched" apart from "clamped to zero" by a GREATEST(reserved - n, 0).
    await ctx.db
      .update(inventory)
      .set({ reserved: 1 })
      .where(eq(inventory.productId, productId));
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

  /** A second product, independent of the fixture's `productId`. */
  async function secondProduct(onHand: number) {
    const [product] = await ctx.db
      .insert(products)
      .values({
        slug: "test-parfum",
        name: "Test Parfum",
        description: "Test",
        priceCents: 6000,
        sku: "T-2",
      })
      .returning();
    await ctx.db.insert(inventory).values({ productId: product.id, onHand });
    return product.id;
  }

  async function addLine(orderId: string, forProductId: string, quantity: number) {
    const [item] = await ctx.db
      .insert(orderItems)
      .values({
        orderId,
        productId: forProductId,
        name: "Test Parfum",
        unitPriceCents: 6000,
        quantity,
        totalCents: 6000 * quantity,
      })
      .returning();
    return item;
  }

  // StockPanel emits one quantity:<id> input per order line and submits them
  // together, so the ordinary production path runs this loop with two or
  // more entries for any order with two products -- not an edge case, and
  // every test above submits exactly one line.
  it("restocks two lines for two different products without crossing them", async () => {
    const { order, item } = await refundedOrder(2);
    const productId2 = await secondProduct(5);
    const item2 = await addLine(order.id, productId2, 3);

    const before1 = (await stock()).onHand;
    const [before2Row] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId2));

    await ctx.db.transaction(async (tx) => {
      await restockOrderItems(
        tx,
        order.id,
        [
          { orderItemId: item.id, quantity: 2 },
          { orderItemId: item2.id, quantity: 3 },
        ],
        "admin_1",
      );
    });

    // Each product moved by its own quantity -- the second product's units
    // were not credited to the first.
    expect((await stock()).onHand).toBe(before1 + 2);
    const [after2] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId2));
    expect(after2.onHand).toBe(before2Row.onHand + 3);

    const ledger = await ctx.db.select().from(inventoryAdjustments);
    expect(ledger).toHaveLength(2);
    const deltaByProduct = Object.fromEntries(
      ledger.map((row) => [row.productId, row.delta]),
    );
    expect(deltaByProduct[productId]).toBe(2);
    expect(deltaByProduct[productId2]).toBe(3);
  });

  it("rolls back both lines when the second exceeds its bound", async () => {
    const { order, item } = await refundedOrder(2);
    const productId2 = await secondProduct(5);
    // Ordered only 1 unit of the second product but the restock claims 5, so
    // that line's bound check fails -- the whole transaction must roll back,
    // including the first line, which would otherwise have succeeded alone.
    const item2 = await addLine(order.id, productId2, 1);

    const before1 = (await stock()).onHand;
    const [before2Row] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId2));

    await expect(
      ctx.db.transaction(async (tx) => {
        await restockOrderItems(
          tx,
          order.id,
          [
            { orderItemId: item.id, quantity: 2 },
            { orderItemId: item2.id, quantity: 5 },
          ],
          "admin_1",
        );
      }),
    ).rejects.toThrow(RestockNotAllowedError);

    expect((await stock()).onHand).toBe(before1);
    const [after2] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId2));
    expect(after2.onHand).toBe(before2Row.onHand);

    const [line1] = await ctx.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.id, item.id));
    expect(line1.restockedQuantity).toBe(0);

    expect(await ctx.db.select().from(inventoryAdjustments)).toHaveLength(0);
  });
});
