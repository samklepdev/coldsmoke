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
  vi.restoreAllMocks();
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

const lines = (quantity = 1) => [
  {
    productId,
    name: "Coldsmoke Eau de Toilette",
    unitPriceCents: 4500,
    quantity,
  },
];

const submit = (existingOrderId: string | null = null) =>
  createPendingOrder({
    cartLines: lines(),
    email: "buyer@example.com",
    shippingAddress: ADDRESS,
    existingOrderId,
  });

async function reserved() {
  const [row] = await ctx.db
    .select()
    .from(inventory)
    .where(eq(inventory.productId, productId));
  return row.reserved;
}

/**
 * The reservation is written in a transaction that commits before the payment
 * intent is created. If that call then fails, the order is left pending with
 * stock held against a payment that will never arrive, and nothing reclaims it
 * until the expiry sweep runs. That is up to RESERVATION_WINDOW_MS of a small
 * catalogue's stock made unsellable by an error we already saw happen.
 */
describe("createPendingOrder when the payment intent fails", () => {
  it("gives the reserved stock back", async () => {
    vi.spyOn(fake, "createOrUpdateIntent").mockRejectedValueOnce(
      new Error("stripe is down"),
    );

    await expect(submit()).rejects.toThrow("stripe is down");

    expect(await reserved()).toBe(0);
  });

  it("cancels the order rather than leaving it pending", async () => {
    vi.spyOn(fake, "createOrUpdateIntent").mockRejectedValueOnce(
      new Error("stripe is down"),
    );

    await expect(submit()).rejects.toThrow();

    const [order] = await ctx.db.select().from(orders);
    expect(order.status).toBe("cancelled");
    expect(order.inventoryState).toBe("released");
    expect(order.cancelledAt).not.toBeNull();
  });

  it("rethrows the original failure, not a cleanup error", async () => {
    vi.spyOn(fake, "createOrUpdateIntent").mockRejectedValueOnce(
      new Error("stripe is down"),
    );

    const err = await submit().catch((e) => e);
    expect(err.message).toBe("stripe is down");
  });

  it("frees the stock for the next buyer", async () => {
    vi.spyOn(fake, "createOrUpdateIntent").mockRejectedValueOnce(
      new Error("stripe is down"),
    );
    await expect(submit()).rejects.toThrow();

    // The whole point: the next customer can still buy it.
    const { order } = await submit();
    expect(order.status).toBe("pending");
    expect(await reserved()).toBe(1);
  });

  it("releases a reused order's reservation too", async () => {
    const first = await submit();

    vi.spyOn(fake, "createOrUpdateIntent").mockRejectedValueOnce(
      new Error("stripe is down"),
    );
    await expect(submit(first.order.id)).rejects.toThrow();

    expect(await reserved()).toBe(0);
    const [order] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, first.order.id));
    expect(order.status).toBe("cancelled");
  });

  it("leaves a successful order untouched", async () => {
    const { order } = await submit();

    expect(order.status).toBe("pending");
    expect(order.inventoryState).toBe("reserved");
    expect(await reserved()).toBe(1);
  });
});
