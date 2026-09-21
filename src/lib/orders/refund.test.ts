import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";
import { FakePayments } from "@/lib/payments/fake";
import { setPayments } from "@/lib/payments";
import { OrderNotRefundableError } from "./errors";

let ctx: Awaited<ReturnType<typeof testDb>>;
let payments: FakePayments;

// refund.ts reads `db` from @/lib/db/client, which points at DATABASE_URL
// (the dev database) rather than TEST_DATABASE_URL. Without this mock the
// fixtures below and the functions under test would land in two different
// databases. Same pattern as claim.test.ts and access.test.ts.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { refundOrder, recordRefund } = await import("./refund");

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US" as const,
};

async function seedOrder(
  status: "paid" | "fulfilled" | "pending",
  refundedCents = 0,
) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      status,
      subtotalCents: 4500,
      totalCents: 5100,
      refundedCents,
      shippingAddress: ADDRESS,
      stripePaymentIntentId: "pi_test_1",
    })
    .returning();
  return order;
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

describe("refundOrder", () => {
  it("refunds the whole remaining amount", async () => {
    const order = await seedOrder("paid");

    const result = await refundOrder({ orderId: order.id });

    expect(result.amountCents).toBe(5100);
    expect(payments.refunds[0]).toEqual({
      paymentIntentId: "pi_test_1",
      amountCents: 5100,
      idempotencyKey: `refund:${order.id}:5100`,
    });
  });

  it("refunds only what is left when part was already refunded", async () => {
    const order = await seedOrder("paid", 1000);

    const result = await refundOrder({ orderId: order.id });

    expect(result.amountCents).toBe(4100);
  });

  it("writes no status of its own", async () => {
    // The webhook is the only writer of refund state. If this action wrote
    // too, a refund issued from the Stripe dashboard would behave differently
    // from one issued here, and the two writers could disagree.
    const order = await seedOrder("paid");

    await refundOrder({ orderId: order.id });

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.status).toBe("paid");
    expect(row.refundedCents).toBe(0);
  });

  it("refunds a fulfilled order", async () => {
    const order = await seedOrder("fulfilled");

    await expect(refundOrder({ orderId: order.id })).resolves.toBeDefined();
  });

  it("refuses an unpaid order and asks Stripe for nothing", async () => {
    const order = await seedOrder("pending");

    await expect(refundOrder({ orderId: order.id })).rejects.toThrow(
      OrderNotRefundableError,
    );
    expect(payments.refunds).toHaveLength(0);
  });

  it("refuses an order that is already fully refunded", async () => {
    const order = await seedOrder("paid", 5100);

    await expect(refundOrder({ orderId: order.id })).rejects.toThrow(
      OrderNotRefundableError,
    );
    expect(payments.refunds).toHaveLength(0);
  });
});

describe("recordRefund", () => {
  it("sets the cumulative amount and does not accumulate it", async () => {
    // Stripe reports amount_refunded as the RUNNING TOTAL for the charge, not
    // the delta of one refund. Two partials of 1000 then 1500 arrive as 1000
    // then 2500. Adding them would give 3500 and wrongly mark the order fully
    // refunded. DO NOT "simplify" this to +=.
    const order = await seedOrder("paid");

    await recordRefund("pi_test_1", "evt_1", 1000);
    const [afterFirst] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(afterFirst.refundedCents).toBe(1000);
    expect(afterFirst.status).toBe("paid");

    await recordRefund("pi_test_1", "evt_2", 2500);
    const [afterSecond] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(afterSecond.refundedCents).toBe(2500);
    expect(afterSecond.status).toBe("paid");
  });

  it("marks the order refunded once the total is covered", async () => {
    const order = await seedOrder("paid");

    await recordRefund("pi_test_1", "evt_1", 5100);

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.refundedCents).toBe(5100);
    expect(row.status).toBe("refunded");
  });

  it("keeps the shipping record on a refunded order", async () => {
    // The parcel really did ship. Erasing the carrier and tracking number
    // would destroy the record of it.
    const order = await seedOrder("fulfilled");
    await ctx.db
      .update(orders)
      .set({ carrier: "USPS", trackingNumber: "TRACK1" })
      .where(eq(orders.id, order.id));

    await recordRefund("pi_test_1", "evt_1", 5100);

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.status).toBe("refunded");
    expect(row.carrier).toBe("USPS");
    expect(row.trackingNumber).toBe("TRACK1");
  });

  it("is a no-op when the event was already processed", async () => {
    await seedOrder("paid");
    await recordRefund("pi_test_1", "evt_1", 5100);

    expect(await recordRefund("pi_test_1", "evt_1", 5100)).toBeNull();
  });

  it("does not double-apply a replayed event", async () => {
    const order = await seedOrder("paid");
    await recordRefund("pi_test_1", "evt_1", 1000);

    await recordRefund("pi_test_1", "evt_1", 1000);

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.refundedCents).toBe(1000);
  });

  it("throws when no order matches the payment intent", async () => {
    // Money moved with no order behind it. Throwing makes the webhook return
    // non-2xx so Stripe retries and surfaces it, rather than swallowing it.
    //
    // Asserts the specific error, not merely that something threw: a bare
    // toThrow() here would pass on a typo or a dropped connection and still
    // look like this path was covered. This project has been caught by that
    // family three times.
    await expect(
      recordRefund("pi_missing", "evt_1", 5100),
    ).rejects.toMatchObject({ name: "OrderNotFoundForPaymentError" });
  });
});

describe("recordRefund ordering and preconditions", () => {
  it("never lets refundedCents go backwards", async () => {
    // Stripe does not guarantee event order. Two dashboard partials of 1000
    // then 1500 emit cumulative 1000 then 2500; delivered out of order an
    // unconditional SET would leave 1000 on an order the 2500 event had
    // already marked refunded -- books saying 1000 on a fully refunded order,
    // which refundOrder then refuses to touch.
    const order = await seedOrder("paid");

    await recordRefund("pi_test_1", "evt_late", 2500);
    await recordRefund("pi_test_1", "evt_early", 1000);

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.refundedCents).toBe(2500);
  });

  it("keeps the order refunded when a stale smaller event arrives after", async () => {
    const order = await seedOrder("paid");

    await recordRefund("pi_test_1", "evt_full", 5100);
    await recordRefund("pi_test_1", "evt_stale", 1000);

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.refundedCents).toBe(5100);
    expect(row.status).toBe("refunded");
  });

  it("refuses to refund an order that was never paid", async () => {
    // If charge.refunded beats payment_intent.succeeded, writing "refunded"
    // over "pending" strands the reservation forever and makes the retried
    // succeeded event throw StrandedPaymentError until Stripe gives up.
    // Throwing here instead returns non-2xx, so Stripe retries this event
    // after the order has become paid.
    const order = await seedOrder("pending");

    await expect(recordRefund("pi_test_1", "evt_early_refund", 5100)).rejects.toThrow(
      /not paid/i,
    );

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.status).toBe("pending");
    expect(row.refundedCents).toBe(0);
  });
});
