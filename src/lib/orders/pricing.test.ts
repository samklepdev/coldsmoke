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

const { createPendingOrder, PriceMismatchError, ProductUnavailableError } =
  await import("./index");

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

function line(overrides: Partial<{ unitPriceCents: number; productId: string }> = {}) {
  return [
    {
      productId: overrides.productId ?? productId,
      name: "Coldsmoke Eau de Toilette",
      unitPriceCents: overrides.unitPriceCents ?? 4500,
      quantity: 1,
    },
  ];
}

const submit = (cartLines: ReturnType<typeof line>) =>
  createPendingOrder({
    cartLines,
    email: "buyer@example.com",
    shippingAddress: ADDRESS,
  });

async function reserved() {
  const [row] = await ctx.db
    .select()
    .from(inventory)
    .where(eq(inventory.productId, productId));
  return row.reserved;
}

/**
 * createPendingOrder's contract says the amount comes from database prices and
 * never from anything the client sent. Until now that held only because every
 * caller happened to pass lines built by getCartLines. Nothing in the module
 * enforced it, so a future caller — or a price changing between cart render
 * and submit — could write an order at a price the catalogue never offered.
 */
describe("createPendingOrder price re-validation", () => {
  it("rejects a line priced below the catalogue", async () => {
    await expect(submit(line({ unitPriceCents: 1 }))).rejects.toThrow(
      PriceMismatchError,
    );
  });

  it("rejects a line priced above the catalogue", async () => {
    await expect(submit(line({ unitPriceCents: 9900 }))).rejects.toThrow(
      PriceMismatchError,
    );
  });

  it("reports both the catalogue price and the price it was given", async () => {
    const err = await submit(line({ unitPriceCents: 1 })).catch((e) => e);
    expect(err).toBeInstanceOf(PriceMismatchError);
    expect(err.expectedCents).toBe(4500);
    expect(err.receivedCents).toBe(1);
    expect(err.productId).toBe(productId);
  });

  it("accepts a line that matches the catalogue", async () => {
    const { order } = await submit(line());
    expect(order.subtotalCents).toBe(4500);
  });

  it("rejects a line whose product no longer exists", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    const err = await submit(line({ productId: missing })).catch((e) => e);

    // Asserting the name too, not just the class. A deleted product used to
    // surface as a foreign-key violation from deep inside the insert, and
    // `toThrow(SomeClass)` matches any error when the class is undefined --
    // so a bare instanceof check here could pass without this guard existing.
    expect(err).toBeInstanceOf(ProductUnavailableError);
    expect(err.name).toBe("ProductUnavailableError");
    expect(err.productId).toBe(missing);
  });

  it("rejects a line whose product has been deactivated", async () => {
    await ctx.db
      .update(products)
      .set({ active: false })
      .where(eq(products.id, productId));

    const err = await submit(line()).catch((e) => e);
    expect(err).toBeInstanceOf(ProductUnavailableError);
    expect(err.name).toBe("ProductUnavailableError");
  });

  it("reserves no stock and writes no order when a price is rejected", async () => {
    // The check has to run before the reservation transaction, or a rejected
    // order still leaves stock held until the sweep reclaims it.
    await expect(submit(line({ unitPriceCents: 1 }))).rejects.toThrow();

    expect(await reserved()).toBe(0);
    expect(await ctx.db.select().from(orders)).toHaveLength(0);
  });
});
