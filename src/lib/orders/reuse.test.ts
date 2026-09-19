import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { products, inventory, orders } from "@/lib/db/schema";
import { FakePayments } from "@/lib/payments/fake";

const fake = new FakePayments();
vi.mock("@/lib/payments", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments")>(
    "@/lib/payments",
  );
  return { ...actual, getPayments: () => fake };
});

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { createPendingOrder } = await import("./index");

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
  // FakePayments is a module-scope singleton (vi.mock above captures one
  // instance for the whole file), so its in-memory state must be reset here
  // just like the database is truncated — otherwise `fake.intents.size`
  // accumulates across tests instead of reflecting the current test alone.
  fake.intents.clear();
  fake.refunds.length = 0;
  const [product] = await ctx.db
    .insert(products)
    .values({
      slug: "edt",
      name: "Coldsmoke Eau de Toilette",
      description: "d",
      priceCents: 4500,
      sku: "CS-1",
    })
    .returning();
  productId = product.id;
  await ctx.db.insert(inventory).values({ productId, onHand: 5, reserved: 0 });
});

function lines(quantity = 1) {
  return [
    {
      productId,
      name: "Coldsmoke Eau de Toilette",
      unitPriceCents: 4500,
      quantity,
    },
  ];
}

async function reserved() {
  const [row] = await ctx.db
    .select()
    .from(inventory)
    .where(eq(inventory.productId, productId));
  return row.reserved;
}

describe("createPendingOrder reuse", () => {
  it("reserves stock once for a first submission", async () => {
    await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
    });
    expect(await reserved()).toBe(1);
  });

  it("does not stack reservations when an address is corrected", async () => {
    const first = await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
    });

    await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: { ...ADDRESS, line1: "2 Powder Lane" },
      existingOrderId: first.order.id,
    });

    expect(await reserved()).toBe(1);

    const rows = await ctx.db.select().from(orders);
    expect(rows).toHaveLength(1);
    expect((rows[0].shippingAddress as typeof ADDRESS).line1).toBe("2 Powder Lane");
  });

  it("adjusts the reservation when the quantity changes", async () => {
    const first = await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
    });

    await createPendingOrder({
      cartLines: lines(3),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
      existingOrderId: first.order.id,
    });

    expect(await reserved()).toBe(3);
  });

  it("reuses the same PaymentIntent rather than creating a second", async () => {
    const first = await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
    });

    const second = await createPendingOrder({
      cartLines: lines(2),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
      existingOrderId: first.order.id,
    });

    expect(second.order.id).toBe(first.order.id);
    expect(fake.intents.size).toBe(1);
  });

  it("starts a fresh order when the existing one is already paid", async () => {
    const first = await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
    });

    await ctx.db
      .update(orders)
      .set({ status: "paid", inventoryState: "committed" })
      .where(eq(orders.id, first.order.id));

    const second = await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
      existingOrderId: first.order.id,
    });

    expect(second.order.id).not.toBe(first.order.id);
    const rows = await ctx.db.select().from(orders);
    expect(rows).toHaveLength(2);
  });
});
