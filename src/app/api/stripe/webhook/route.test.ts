import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import {
  products,
  inventory,
  carts,
  cartItems,
  orders,
  stripeEvents,
} from "@/lib/db/schema";
import { FakePayments } from "@/lib/payments/fake";

const fake = new FakePayments();
vi.mock("@/lib/payments", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments")>(
    "@/lib/payments",
  );
  return { ...actual, getPayments: () => fake };
});

// Never reach out to Resend from a test. The real module swallows its own
// errors, which would hide a call that should not be happening at all.
const sendOrderConfirmation = vi.fn(async () => {});
vi.mock("@/lib/email", () => ({ sendOrderConfirmation }));

// Spied so a test can make the post-payment side effects fail on demand.
const clearCart = vi.fn();
vi.mock("@/lib/cart", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/cart")>("@/lib/cart");
  return { ...actual, clearCart: (id: string) => clearCart(id) };
});

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { POST } = await import("./route");
const { createPendingOrder } = await import("@/lib/orders");

let bottleId: string;
let cartId: string;

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US" as const,
};

function post(body: string, signature: string | null = "sig_ok"): Promise<Response> {
  return POST(
    new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body,
      headers: signature ? { "stripe-signature": signature } : {},
    }),
  );
}

async function placeOrder() {
  const { order } = await createPendingOrder({
    cartLines: [
      {
        productId: bottleId,
        name: "Coldsmoke Eau de Toilette",
        unitPriceCents: 4500,
        quantity: 1,
      },
    ],
    cartId,
    email: "buyer@example.com",
    shippingAddress: ADDRESS,
  });
  return order;
}

async function stock() {
  const [row] = await ctx.db
    .select()
    .from(inventory)
    .where(eq(inventory.productId, bottleId));
  return row;
}

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
  sendOrderConfirmation.mockClear();
  clearCart.mockReset();
  clearCart.mockResolvedValue(undefined);

  const [bottle] = await ctx.db
    .insert(products)
    .values({
      slug: "coldsmoke-edt-50ml",
      name: "Coldsmoke Eau de Toilette",
      description: "d",
      priceCents: 4500,
      sku: "CS-1",
    })
    .returning();
  bottleId = bottle.id;
  await ctx.db.insert(inventory).values({ productId: bottleId, onHand: 5 });

  const [cart] = await ctx.db.insert(carts).values({}).returning();
  cartId = cart.id;
  await ctx.db
    .insert(cartItems)
    .values({ cartId: cart.id, productId: bottleId, quantity: 1 });
});

describe("rejecting bad requests", () => {
  it("400s without a stripe-signature header", async () => {
    const response = await post("{}", null);
    expect(response.status).toBe(400);
  });

  it("400s when signature verification fails", async () => {
    // The fake verifies by parsing; malformed JSON stands in for a bad sig.
    const response = await post("not json");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid signature" });
  });
});

describe("payment_intent.succeeded", () => {
  it("marks the order paid, commits the stock, and clears the cart", async () => {
    const order = await placeOrder();
    expect((await stock()).reserved).toBe(1);

    const response = await post(
      fake.succeededEvent(order.stripePaymentIntentId!),
    );

    expect(response.status).toBe(200);

    const [updated] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(updated.status).toBe("paid");
    expect(updated.inventoryState).toBe("committed");

    const after = await stock();
    expect(after.onHand).toBe(4);
    expect(after.reserved).toBe(0);

    expect(clearCart).toHaveBeenCalledWith(cartId);
    expect(sendOrderConfirmation).toHaveBeenCalledTimes(1);
  });

  it("is idempotent when Stripe replays the same event", async () => {
    const order = await placeOrder();
    const event = fake.succeededEvent(order.stripePaymentIntentId!);

    expect((await post(event)).status).toBe(200);
    const afterFirst = await stock();

    expect((await post(event)).status).toBe(200);
    const afterSecond = await stock();

    // The replay must not decrement stock or send a second email.
    expect(afterSecond.onHand).toBe(afterFirst.onHand);
    expect(afterSecond.reserved).toBe(afterFirst.reserved);
    expect(sendOrderConfirmation).toHaveBeenCalledTimes(1);
  });

  it("500s and records no event when the charge has no order behind it", async () => {
    // A real charge whose order was swept away. Stripe must retry, so the
    // ledger insert has to roll back rather than marking it processed.
    const response = await post(
      JSON.stringify({
        id: "evt_orphan",
        type: "payment_intent.succeeded",
        paymentIntentId: "pi_nonexistent",
        amountCents: 5508,
        metadata: {},
      }),
    );

    expect(response.status).toBe(500);

    const ledger = await ctx.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, "evt_orphan"));
    expect(ledger).toHaveLength(0);
  });

  it("still 200s when the post-payment side effects fail", async () => {
    // The payment is already committed at this point. A 500 here would make
    // Stripe retry an event whose retry is a guaranteed no-op.
    const order = await placeOrder();
    clearCart.mockRejectedValue(new Error("cart store unavailable"));

    const response = await post(
      fake.succeededEvent(order.stripePaymentIntentId!),
    );

    expect(response.status).toBe(200);

    const [updated] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(updated.status).toBe("paid");
    expect((await stock()).onHand).toBe(4);
  });
});

describe("payment_intent.payment_failed", () => {
  it("leaves the order pending with its reservation intact for a retry", async () => {
    const order = await placeOrder();

    const response = await post(
      JSON.stringify({
        id: "evt_failed_1",
        type: "payment_intent.payment_failed",
        paymentIntentId: order.stripePaymentIntentId,
        amountCents: order.totalCents,
        metadata: {},
      }),
    );

    expect(response.status).toBe(200);

    const [updated] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    // Releasing here would let someone else take the last bottle while the
    // customer is typing a second card number.
    expect(updated.status).toBe("pending");
    expect(updated.inventoryState).toBe("reserved");
    expect((await stock()).reserved).toBe(1);
  });

  it("records the failure event so a replay is a no-op", async () => {
    const order = await placeOrder();
    const event = JSON.stringify({
      id: "evt_failed_2",
      type: "payment_intent.payment_failed",
      paymentIntentId: order.stripePaymentIntentId,
      amountCents: order.totalCents,
      metadata: {},
    });

    expect((await post(event)).status).toBe(200);
    expect((await post(event)).status).toBe(200);

    const ledger = await ctx.db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, "evt_failed_2"));
    expect(ledger).toHaveLength(1);
  });
});
