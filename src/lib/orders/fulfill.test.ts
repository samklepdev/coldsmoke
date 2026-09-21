import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";
import { OrderNotFoundError, OrderNotFulfillableError } from "./errors";

let ctx: Awaited<ReturnType<typeof testDb>>;

// fulfill.ts reads `db` from @/lib/db/client, which points at DATABASE_URL
// (the dev database) rather than TEST_DATABASE_URL. Without this mock the
// fixtures below and fulfillOrder's own reads would land in two different
// databases. Same pattern as claim.test.ts and access.test.ts, the other
// files that import their module directly rather than through index.ts.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { fulfillOrder } = await import("./fulfill");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US" as const,
};

async function seedOrder(status: "pending" | "paid" | "fulfilled" | "refunded") {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      status,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingCents: 600,
      shippingAddress: ADDRESS,
      stripePaymentIntentId: "pi_test_1",
    })
    .returning();
  return order;
}

describe("fulfillOrder", () => {
  it("records the carrier, the tracking number and the time", async () => {
    const seeded = await seedOrder("paid");

    const order = await fulfillOrder({
      orderId: seeded.id,
      carrier: "USPS",
      trackingNumber: "9400111899223197428490",
    });

    expect(order.status).toBe("fulfilled");
    expect(order.carrier).toBe("USPS");
    expect(order.trackingNumber).toBe("9400111899223197428490");
    expect(order.fulfilledAt).toBeInstanceOf(Date);
  });

  it("refuses an order that was never paid", async () => {
    const seeded = await seedOrder("pending");

    await expect(
      fulfillOrder({ orderId: seeded.id, carrier: "USPS", trackingNumber: "X" }),
    ).rejects.toThrow(OrderNotFulfillableError);
  });

  it("refuses to fulfil the same order twice", async () => {
    // Two admins with the page open, or one double-submit. The second must
    // not overwrite the first parcel's tracking number.
    const seeded = await seedOrder("paid");
    await fulfillOrder({
      orderId: seeded.id,
      carrier: "USPS",
      trackingNumber: "FIRST",
    });

    await expect(
      fulfillOrder({ orderId: seeded.id, carrier: "UPS", trackingNumber: "SECOND" }),
    ).rejects.toThrow(OrderNotFulfillableError);

    const [row] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, seeded.id));
    expect(row.trackingNumber).toBe("FIRST");
  });

  it("refuses a refunded order", async () => {
    const seeded = await seedOrder("refunded");

    await expect(
      fulfillOrder({ orderId: seeded.id, carrier: "USPS", trackingNumber: "X" }),
    ).rejects.toThrow(OrderNotFulfillableError);
  });

  it("refuses an order that does not exist", async () => {
    await expect(
      fulfillOrder({
        orderId: "00000000-0000-0000-0000-000000000000",
        carrier: "USPS",
        trackingNumber: "X",
      }),
    ).rejects.toThrow(OrderNotFoundError);
  });
});
