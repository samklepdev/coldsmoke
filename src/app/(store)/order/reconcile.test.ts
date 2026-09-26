import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { products, inventory, carts, cartItems, orders } from "@/lib/db/schema";
import { FakePayments } from "@/lib/payments/fake";

const fake = new FakePayments();
vi.mock("@/lib/payments", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments")>(
    "@/lib/payments",
  );
  return { ...actual, getPayments: () => fake };
});

const sent: string[] = [];
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: async (order: { id: string }) => {
    sent.push(order.id);
  },
}));

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { reconcilePendingOrder, reconcileEventId } = await import(
  "@/lib/orders/reconcile"
);
const { markOrderPaid } = await import("@/lib/orders");
const { completePaidOrder } = await import("@/lib/orders/completePaid");

let cartId: string;
let productId: string;

/** A pending order with a cart that still holds two items — order 1030's shape. */
async function pendingOrder(paymentIntentId: string | null) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      orderNumber: 1030,
      email: "buyer@example.com",
      status: "pending",
      cartId,
      stripePaymentIntentId: paymentIntentId,
      subtotalCents: 4500,
      shippingCents: 600,
      taxCents: 0,
      discountCents: 0,
      totalCents: 5100,
      // `line2` is omitted, not null: Address types it `line2?: string`, so
      // null does not type-check.
      shippingAddress: {
        name: "Test Buyer",
        line1: "1 Powder Lane",
        city: "Bozeman",
        state: "MT",
        postalCode: "59715",
        country: "US",
      },
    })
    .returning();
  return order;
}

async function intentFor(orderId: string) {
  const { paymentIntentId } = await fake.createOrUpdateIntent({
    paymentIntentId: null,
    amountCents: 5100,
    email: "buyer@example.com",
    orderId,
    orderNumber: 1030,
  });
  return paymentIntentId;
}

/**
 * Summed, not counted. The header badge that read "Cart (2)" — the symptom
 * that surfaced this bug — is a sum of quantities, and the fixture is a
 * single row of quantity 2. Counting rows would assert 1 and quietly stop
 * describing what the customer saw.
 */
const itemsLeft = async () =>
  (
    await ctx.db.select().from(cartItems).where(eq(cartItems.cartId, cartId))
  ).reduce((sum, line) => sum + line.quantity, 0);

const statusOf = async (id: string) =>
  (await ctx.db.select().from(orders).where(eq(orders.id, id)))[0].status;

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

/**
 * reconcilePendingOrder swallows everything (it runs during a page render), so
 * "returned false and changed nothing" is what a correct no-op AND an internal
 * exception both look like from outside. Its one visible trace is the
 * console.error in the catch, so the no-op tests assert that it stayed silent —
 * otherwise deleting markOrderPaid's short-circuit would leave them green while
 * the code threw on every call.
 */
let swallowed: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await ctx.truncate();
  fake.intents.clear();
  sent.length = 0;
  swallowed = vi.spyOn(console, "error").mockImplementation(() => {});

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
  productId = bottle.id;
  await ctx.db.insert(inventory).values({ productId, onHand: 5 });

  const [cart] = await ctx.db.insert(carts).values({}).returning();
  cartId = cart.id;
  await ctx.db.insert(cartItems).values({ cartId, productId, quantity: 2 });
});

afterEach(() => {
  swallowed.mockRestore();
});

describe("reconcilePendingOrder", () => {
  it("marks a pending order paid when Stripe says the intent succeeded", async () => {
    // Order 1030's exact situation: Stripe captured the money, the webhook
    // never arrived, and the cart still holds what was bought.
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));
    fake.markSucceeded(pi);

    const changed = await reconcilePendingOrder({
      ...order,
      stripePaymentIntentId: pi,
    });

    expect(changed).toBe(true);
    expect(await statusOf(order.id)).toBe("paid");
    expect(await itemsLeft()).toBe(0);
    expect(sent).toEqual([order.id]);
  });

  it("leaves a still-processing payment alone", async () => {
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));
    fake.setIntentStatus(pi, "processing");

    const changed = await reconcilePendingOrder({
      ...order,
      stripePaymentIntentId: pi,
    });

    expect(changed).toBe(false);
    expect(await statusOf(order.id)).toBe("pending");
    expect(await itemsLeft()).toBe(2);
    expect(sent).toEqual([]);
    expect(swallowed).not.toHaveBeenCalled();
  });

  it("leaves an unpaid intent alone", async () => {
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));

    const changed = await reconcilePendingOrder({
      ...order,
      stripePaymentIntentId: pi,
    });

    expect(changed).toBe(false);
    expect(await statusOf(order.id)).toBe("pending");
    expect(swallowed).not.toHaveBeenCalled();
  });

  it("does nothing for an order with no payment intent", async () => {
    const order = await pendingOrder(null);

    const changed = await reconcilePendingOrder(order);

    expect(changed).toBe(false);
    expect(await statusOf(order.id)).toBe("pending");
    expect(swallowed).not.toHaveBeenCalled();
  });

  it("sends no second email when the webhook already completed the order", async () => {
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));
    fake.markSucceeded(pi);

    // The webhook wins the race — BOTH of its phases. Calling only
    // markOrderPaid would leave `sent` empty for the trivial reason that the
    // email lives in completePaidOrder, so the assertion below would read
    // "reconciliation sent none" rather than the guarantee we actually want:
    // exactly one email across the whole interleaving.
    const paid = await markOrderPaid(pi, "evt_real_1");
    expect(paid).not.toBeNull();
    await completePaidOrder(paid!.id, paid!.cartId);
    expect(sent).toEqual([order.id]);

    const changed = await reconcilePendingOrder({
      ...order,
      stripePaymentIntentId: pi,
    });

    expect(changed).toBe(false);
    expect(sent).toEqual([order.id]);
    expect(swallowed).not.toHaveBeenCalled();
  });

  it("is safe to run twice — the ledger key stops the second", async () => {
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));
    fake.markSucceeded(pi);
    const withPi = { ...order, stripePaymentIntentId: pi };

    expect(await reconcilePendingOrder(withPi)).toBe(true);
    expect(await reconcilePendingOrder(withPi)).toBe(false);
    expect(sent).toEqual([order.id]);
  });

  it("swallows a payments failure rather than breaking the page", async () => {
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));

    const boom = vi
      .spyOn(fake, "getIntentStatus")
      .mockRejectedValue(new Error("stripe is down"));

    // Must resolve, not reject: this runs inside a page render.
    const changed = await reconcilePendingOrder({
      ...order,
      stripePaymentIntentId: pi,
    });

    expect(changed).toBe(false);
    expect(await statusOf(order.id)).toBe("pending");
    // The other side of the silence assertions above: here the catch SHOULD
    // have fired, which is what makes "not called" meaningful elsewhere.
    expect(swallowed).toHaveBeenCalled();
    boom.mockRestore();
  });

  it("namespaces its ledger key away from real Stripe event ids", () => {
    // Real ids begin "evt_". A collision would make one path silently skip.
    expect(reconcileEventId("pi_123")).toBe("reconcile:pi_123");
    expect(reconcileEventId("pi_123").startsWith("evt_")).toBe(false);
  });
});
