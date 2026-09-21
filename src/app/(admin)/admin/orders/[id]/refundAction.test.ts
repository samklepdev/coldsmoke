import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";
import { FakePayments } from "@/lib/payments/fake";
import { setPayments } from "@/lib/payments";

let ctx: Awaited<ReturnType<typeof testDb>>;
let payments: FakePayments;

// The action reaches the database through @/lib/db/client, which resolves
// DATABASE_URL -- the dev database -- while testDb() connects to the test
// one. Without this the fixtures and the code under test would sit in two
// different databases and the assertions would mean nothing.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

vi.mock("@/lib/auth/session", () => ({
  requireAdminUser: async () => ({
    id: "admin1",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    emailVerified: true,
  }),
}));

vi.mock("@/lib/email/shipping", () => ({
  sendShippingConfirmation: async () => ({ delivered: true }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { refundAction } = await import("./actions");

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US" as const,
};

async function seedOrder(status: "paid" | "pending" | "fulfilled") {
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
  payments = new FakePayments();
  setPayments(payments);
});

describe("refundAction", () => {
  it("submits the refund and reports the amount", async () => {
    const order = await seedOrder("paid");

    const state = await refundAction({ status: "idle" }, form({ orderId: order.id }));

    expect(state).toEqual({ status: "submitted", amountCents: 5100 });
  });

  it("leaves the order untouched until the webhook lands", async () => {
    // The action moves money; the webhook moves status. Showing "refunded"
    // here would be two writers disagreeing about the same order.
    const order = await seedOrder("paid");

    await refundAction({ status: "idle" }, form({ orderId: order.id }));

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.status).toBe("paid");
    expect(row.refundedCents).toBe(0);
  });

  it("reports a refusal rather than throwing", async () => {
    const order = await seedOrder("pending");

    const state = await refundAction({ status: "idle" }, form({ orderId: order.id }));

    expect(state).toMatchObject({ status: "error" });
    expect(payments.refunds).toHaveLength(0);
  });

  it("rejects a malformed order id without asking Stripe for anything", async () => {
    const state = await refundAction({ status: "idle" }, form({ orderId: "nope" }));

    expect(state).toMatchObject({ status: "error" });
    expect(payments.refunds).toHaveLength(0);
  });

  it("sends the same idempotency key for a double submit", async () => {
    // Two clicks are two calls. The key is what stops the second becoming a
    // second refund.
    const order = await seedOrder("paid");

    await refundAction({ status: "idle" }, form({ orderId: order.id }));
    await refundAction({ status: "idle" }, form({ orderId: order.id }));

    expect(payments.refunds).toHaveLength(1);
    expect(payments.refunds[0].idempotencyKey).toBe(`refund:${order.id}:5100`);
  });
});
