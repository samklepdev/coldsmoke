import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { orders, orderItems, products } from "@/lib/db/schema";
import type { Address } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { getOrdersForUser } = await import("./history");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

let productId: string;

beforeEach(async () => {
  await ctx.truncate();
  const [product] = await ctx.db
    .insert(products)
    .values({
      slug: "coldsmoke-edt",
      name: "Coldsmoke Eau de Toilette",
      description: "Cold air. Dark spice.",
      priceCents: 4500,
      sku: "CS-EDT-50",
    })
    .returning({ id: products.id });
  productId = product.id;
});

const ADDRESS: Address = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

async function placeOrder(userId: string | null, createdAt: Date) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      userId,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingAddress: ADDRESS,
      createdAt,
    })
    .returning({ id: orders.id });

  await ctx.db.insert(orderItems).values({
    orderId: order.id,
    productId,
    name: "Coldsmoke Eau de Toilette",
    unitPriceCents: 4500,
    quantity: 1,
    totalCents: 4500,
  });

  return order.id;
}

describe("getOrdersForUser", () => {
  it("returns the customer's orders, newest first", async () => {
    const older = await placeOrder("user_1", new Date("2026-01-01"));
    const newer = await placeOrder("user_1", new Date("2026-06-01"));

    const history = await getOrdersForUser("user_1");

    expect(history.map((o) => o.id)).toEqual([newer, older]);
  });

  it("excludes another customer's orders", async () => {
    await placeOrder("user_2", new Date("2026-01-01"));

    expect(await getOrdersForUser("user_1")).toEqual([]);
  });

  it("excludes guest orders nobody has claimed", async () => {
    // Unclaimed means unverified. Showing it here would leak an order to
    // whoever happened to be signed in.
    await placeOrder(null, new Date("2026-01-01"));

    expect(await getOrdersForUser("user_1")).toEqual([]);
  });

  it("includes the line items", async () => {
    await placeOrder("user_1", new Date("2026-01-01"));

    const [order] = await getOrdersForUser("user_1");
    expect(order.items).toHaveLength(1);
    expect(order.items[0].name).toBe("Coldsmoke Eau de Toilette");
  });

  it("returns an empty list for a customer with no orders", async () => {
    expect(await getOrdersForUser("user_1")).toEqual([]);
  });
});
