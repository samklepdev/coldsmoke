import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testDb } from "@/test/db";
import { products, inventory, orders, orderItems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  reserveStock,
  commitStock,
  releaseStock,
  releaseExpiredReservations,
  OutOfStockError,
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
