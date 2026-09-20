import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { products, inventory, orders, discountCodes, stripeEvents } from "@/lib/db/schema";
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

const { createPendingOrder, markOrderPaid, StrandedPaymentError, OrderNotFoundForPaymentError } =
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

async function inventoryRow() {
  const [row] = await ctx.db
    .select()
    .from(inventory)
    .where(eq(inventory.productId, productId));
  return row;
}

async function createOrder(quantity = 1) {
  const created = await createPendingOrder({
    cartLines: lines(quantity),
    email: "buyer@example.com",
    shippingAddress: ADDRESS,
  });
  // createPendingOrder writes stripePaymentIntentId in a follow-up UPDATE
  // after its transaction commits, so the in-memory `order` it returns does
  // not carry it — re-fetch to get the persisted value tests need.
  const [refetched] = await ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, created.order.id));
  return { ...created, order: refetched };
}

describe("markOrderPaid", () => {
  it("transitions a pending order to paid, sets paidAt, and commits stock", async () => {
    const { order } = await createOrder(1);

    const result = await markOrderPaid(order.stripePaymentIntentId!, "evt_1");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("paid");
    expect(result!.paidAt).not.toBeNull();

    const row = await inventoryRow();
    expect(row.onHand).toBe(4);
    expect(row.reserved).toBe(0);
  });

  it("is idempotent: the same event id delivered twice marks paid once and decrements stock once", async () => {
    const { order } = await createOrder(1);

    const first = await markOrderPaid(order.stripePaymentIntentId!, "evt_dup");
    const second = await markOrderPaid(order.stripePaymentIntentId!, "evt_dup");

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const row = await inventoryRow();
    expect(row.onHand).toBe(4);
    expect(row.reserved).toBe(0);
  });

  it("returns null for a different event id on an already-paid order, without double-committing stock", async () => {
    const { order } = await createOrder(1);

    const first = await markOrderPaid(order.stripePaymentIntentId!, "evt_a");
    const second = await markOrderPaid(order.stripePaymentIntentId!, "evt_b");

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const row = await inventoryRow();
    expect(row.onHand).toBe(4);
    expect(row.reserved).toBe(0);
  });

  it("throws StrandedPaymentError for an order in a non-pending, non-paid state, and rolls back the stripe_events insert", async () => {
    const { order } = await createOrder(1);

    await ctx.db
      .update(orders)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(orders.id, order.id));

    await expect(
      markOrderPaid(order.stripePaymentIntentId!, "evt_stranded"),
    ).rejects.toThrow(StrandedPaymentError);

    const rows = await ctx.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, "evt_stranded"));
    expect(rows).toHaveLength(0);
  });

  it("throws OrderNotFoundForPaymentError for an unknown payment intent id", async () => {
    await expect(
      markOrderPaid("pi_does_not_exist", "evt_unknown"),
    ).rejects.toThrow(OrderNotFoundForPaymentError);

    const rows = await ctx.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, "evt_unknown"));
    expect(rows).toHaveLength(0);
  });

  it("marks the order paid even when the discount's redemption cap is already exhausted", async () => {
    const [discount] = await ctx.db
      .insert(discountCodes)
      .values({
        code: "capped",
        type: "fixed",
        value: 500,
        maxRedemptions: 1,
        timesRedeemed: 1, // already exhausted
      })
      .returning();

    const { order: created } = await createOrder(1);
    await ctx.db
      .update(orders)
      .set({ discountCodeId: discount.id })
      .where(eq(orders.id, created.id));

    const result = await markOrderPaid(created.stripePaymentIntentId!, "evt_capped");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("paid");
  });

  /**
   * Honouring an over-cap discount is the right call — the customer has already
   * been charged the discounted total — but it used to leave no trace beyond a
   * console.warn. A log line is not a record: it cannot be queried, it is gone
   * once the process restarts, and nobody can answer "how often did this
   * happen, and on which orders?" from it.
   */
  it("records on the order that the discount cap was overrun", async () => {
    const [discount] = await ctx.db
      .insert(discountCodes)
      .values({
        code: "capped2",
        type: "fixed",
        value: 500,
        maxRedemptions: 1,
        timesRedeemed: 1, // already exhausted
      })
      .returning();

    const { order: created } = await createOrder(1);
    await ctx.db
      .update(orders)
      .set({ discountCodeId: discount.id })
      .where(eq(orders.id, created.id));

    const result = await markOrderPaid(created.stripePaymentIntentId!, "evt_capped2");

    // toBeInstanceOf(Date), not .not.toBeNull(): undefined is not null, so a
    // not-null assertion passes while the column does not exist at all.
    expect(result!.discountOverrunAt).toBeInstanceOf(Date);

    // And it is durable, not just present on the returned row.
    const [stored] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, created.id));
    expect(stored.discountOverrunAt).toBeInstanceOf(Date);
  });

  it("leaves the overrun marker unset when the discount redeems normally", async () => {
    const [discount] = await ctx.db
      .insert(discountCodes)
      .values({
        code: "roomy",
        type: "fixed",
        value: 500,
        maxRedemptions: 5,
        timesRedeemed: 0,
      })
      .returning();

    const { order: created } = await createOrder(1);
    await ctx.db
      .update(orders)
      .set({ discountCodeId: discount.id })
      .where(eq(orders.id, created.id));

    const result = await markOrderPaid(created.stripePaymentIntentId!, "evt_roomy");

    expect(result!.status).toBe("paid");
    expect(result!.discountOverrunAt).toBeNull();
  });

  it("leaves the overrun marker unset for an order with no discount", async () => {
    const { order: created } = await createOrder(1);

    const result = await markOrderPaid(created.stripePaymentIntentId!, "evt_nodisc");

    expect(result!.discountOverrunAt).toBeNull();
  });
});
