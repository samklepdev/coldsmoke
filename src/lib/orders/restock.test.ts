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
