import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testDb } from "@/test/db";
import { products, inventory, orders, orderItems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  reserveStock,
  commitStock,
  releaseStock,
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
