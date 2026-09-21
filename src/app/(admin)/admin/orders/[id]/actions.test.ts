import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;

// The action reaches the database through @/lib/db/client, which resolves
// DATABASE_URL -- the dev database -- while testDb() connects to the test one.
// Without this the fixtures below and the code under test would sit in two
// different databases and the assertions would mean nothing.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const sendShippingConfirmation = vi.fn(async () => ({ delivered: true }));
vi.mock("@/lib/email/shipping", () => ({
  sendShippingConfirmation: () => sendShippingConfirmation(),
}));

vi.mock("@/lib/auth/session", () => ({
  requireAdminUser: async () => ({
    id: "admin1",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    emailVerified: true,
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { fulfillAction } = await import("./actions");

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US" as const,
};

async function seedOrder(status: "paid" | "pending") {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      status,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingAddress: ADDRESS,
      stripePaymentIntentId: "pi_test_1",
    })
    .returning();
  return order;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  sendShippingConfirmation.mockReset();
  sendShippingConfirmation.mockResolvedValue({ delivered: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("fulfillAction", () => {
  it("fulfils the order and reports success", async () => {
    const order = await seedOrder("paid");

    const state = await fulfillAction(
      { status: "idle" },
      form({ orderId: order.id, carrier: "USPS", trackingNumber: "TRACK1" }),
    );

    expect(state).toEqual({ status: "fulfilled" });
  });

  it("says so when the shipping email was rejected", async () => {
    const order = await seedOrder("paid");
    sendShippingConfirmation.mockResolvedValueOnce({ delivered: false });

    const state = await fulfillAction(
      { status: "idle" },
      form({ orderId: order.id, carrier: "USPS", trackingNumber: "TRACK1" }),
    );

    expect(state).toEqual({ status: "fulfilled-undelivered" });
  });

  it("keeps the fulfilment when the email fails", async () => {
    // The parcel shipped. Losing that record because Resend was down would be
    // far worse than an unsent email, and the admin can resend. This is the
    // whole reason the send happens after the transaction commits.
    const order = await seedOrder("paid");
    sendShippingConfirmation.mockResolvedValueOnce({ delivered: false });

    await fulfillAction(
      { status: "idle" },
      form({ orderId: order.id, carrier: "USPS", trackingNumber: "TRACK1" }),
    );

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.status).toBe("fulfilled");
    expect(row.carrier).toBe("USPS");
    expect(row.trackingNumber).toBe("TRACK1");
    expect(row.fulfilledAt).toBeInstanceOf(Date);
  });

  it("refuses an order that is not paid, and sends no email", async () => {
    const order = await seedOrder("pending");

    const state = await fulfillAction(
      { status: "idle" },
      form({ orderId: order.id, carrier: "USPS", trackingNumber: "TRACK1" }),
    );

    expect(state).toMatchObject({ status: "error" });
    expect(sendShippingConfirmation).not.toHaveBeenCalled();
  });

  it("requires both a carrier and a tracking number", async () => {
    const order = await seedOrder("paid");

    const state = await fulfillAction(
      { status: "idle" },
      form({ orderId: order.id, carrier: "", trackingNumber: "" }),
    );

    expect(state).toMatchObject({ status: "error" });
    expect(sendShippingConfirmation).not.toHaveBeenCalled();
  });

  it("rejects a malformed order id without touching the database", async () => {
    const state = await fulfillAction(
      { status: "idle" },
      form({ orderId: "not-a-uuid", carrier: "USPS", trackingNumber: "TRACK1" }),
    );

    expect(state).toMatchObject({ status: "error" });
    expect(sendShippingConfirmation).not.toHaveBeenCalled();
  });
});
