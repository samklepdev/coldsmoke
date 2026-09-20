import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  orders,
  orderItems,
  stripeEvents,
  type Order,
  type OrderItem,
  type Address,
} from "@/lib/db/schema";
import { quote, type QuoteLine, type AppliedDiscount } from "@/lib/pricing/quote";
import {
  reserveStock,
  releaseStock,
  commitStock,
  RESERVATION_WINDOW_MS,
} from "@/lib/inventory";
import { redeemDiscount } from "@/lib/discounts";
import { getProductsByIds } from "@/lib/catalog";
import { getPayments } from "@/lib/payments";

export * from "./format";

export type OrderWithItems = Order & { items: OrderItem[] };

/**
 * Thrown when a line names a product that cannot be sold — deleted, or no
 * longer active. Reaching checkout with one means the cart outlived the
 * catalogue entry, so the order must not be written at the stale terms.
 */
export class ProductUnavailableError extends Error {
  constructor(public readonly productId: string) {
    super(`Product ${productId} is not available for purchase`);
    this.name = "ProductUnavailableError";
  }
}

/**
 * Thrown when a line's price disagrees with the catalogue. Charging the
 * caller's figure would bill a price the catalogue never offered; charging the
 * catalogue's silently would bill a price the customer was never shown. Both
 * are wrong, so this refuses and lets the caller re-quote.
 */
export class PriceMismatchError extends Error {
  constructor(
    public readonly productId: string,
    public readonly expectedCents: number,
    public readonly receivedCents: number,
  ) {
    super(
      `Product ${productId} is priced ${expectedCents} in the catalogue, not ${receivedCents}`,
    );
    this.name = "PriceMismatchError";
  }
}

/**
 * Treats the caller's prices as a claim rather than as fact.
 *
 * This is what makes createPendingOrder's "never from anything the client
 * sent" guarantee true. It previously held only because every caller happened
 * to build its lines from getCartLines — a convention nothing enforced, and
 * one a price change between cart render and submit breaks on its own.
 */
async function assertLinesMatchCatalog(cartLines: QuoteLine[]): Promise<void> {
  const catalog = await getProductsByIds(cartLines.map((l) => l.productId));
  const byId = new Map(catalog.map((p) => [p.id, p]));

  for (const line of cartLines) {
    const product = byId.get(line.productId);
    if (!product || !product.active) {
      throw new ProductUnavailableError(line.productId);
    }
    if (product.priceCents !== line.unitPriceCents) {
      throw new PriceMismatchError(
        line.productId,
        product.priceCents,
        line.unitPriceCents,
      );
    }
  }
}

/**
 * Creates (or refreshes) a pending order and its PaymentIntent.
 *
 * The amount is computed here from database prices — never from anything the
 * client sent. Inventory is reserved in the same transaction that writes the
 * order, so a successful return means the stock is genuinely held.
 */
export async function createPendingOrder(args: {
  cartLines: QuoteLine[];
  cartId?: string | null;
  email: string;
  shippingAddress: Address;
  billingAddress?: Address | null;
  discount?: AppliedDiscount | null;
  existingOrderId?: string | null;
}): Promise<{ order: Order; clientSecret: string }> {
  const { cartLines, email, shippingAddress, discount = null } = args;

  if (cartLines.length === 0) throw new Error("Cannot create an order from an empty cart");

  // Before the tax call and before any stock is reserved: a rejected order
  // should cost neither a Stripe round trip nor a reservation to reclaim.
  await assertLinesMatchCatalog(cartLines);

  const payments = getPayments();
  const preTax = quote(cartLines, discount, 0);
  const tax = await payments.calculateTax({
    lines: cartLines,
    shippingCents: preTax.shippingCents,
    discountCents: preTax.discountCents,
    address: shippingAddress,
  });
  const final = quote(cartLines, discount, tax.taxCents);

  const money = {
    email,
    cartId: args.cartId ?? null,
    discountCodeId: discount?.id ?? null,
    subtotalCents: final.subtotalCents,
    discountCents: final.discountCents,
    shippingCents: final.shippingCents,
    taxCents: final.taxCents,
    totalCents: final.totalCents,
    shippingAddress,
    billingAddress: args.billingAddress ?? shippingAddress,
    reservationExpiresAt: new Date(Date.now() + RESERVATION_WINDOW_MS),
  };

  const lineValues = (orderId: string) =>
    cartLines.map((line) => ({
      orderId,
      productId: line.productId,
      name: line.name,
      unitPriceCents: line.unitPriceCents,
      quantity: line.quantity,
      totalCents: line.unitPriceCents * line.quantity,
    }));

  const reusable = args.existingOrderId
    ? await findReusablePendingOrder(args.existingOrderId)
    : null;

  const order = await db.transaction(async (tx) => {
    if (reusable) {
      // Editing an address must not stack a second reservation on top of the
      // first. Give the old units back, then re-reserve against the new lines.
      await releaseStock(tx, reusable.id);
      await tx.delete(orderItems).where(eq(orderItems.orderId, reusable.id));
      await tx.insert(orderItems).values(lineValues(reusable.id));

      await reserveStock(
        tx,
        cartLines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      );

      const [updated] = await tx
        .update(orders)
        .set({ ...money, inventoryState: "reserved" })
        .where(eq(orders.id, reusable.id))
        .returning();

      return updated;
    }

    const [created] = await tx
      .insert(orders)
      .values({ ...money, status: "pending" })
      .returning();

    await tx.insert(orderItems).values(lineValues(created.id));

    // Throws OutOfStockError and rolls back the order if stock is gone.
    await reserveStock(
      tx,
      cartLines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
    );
    await tx
      .update(orders)
      .set({ inventoryState: "reserved" })
      .where(eq(orders.id, created.id));

    return created;
  });

  let intent;
  try {
    intent = await payments.createOrUpdateIntent({
      paymentIntentId: reusable?.stripePaymentIntentId ?? null,
      amountCents: final.totalCents,
      email,
      orderId: order.id,
      orderNumber: order.orderNumber,
    });
  } catch (err) {
    // The reservation transaction has already committed. Leaving it alone
    // holds stock against a payment that will never arrive until the expiry
    // sweep reclaims it — up to RESERVATION_WINDOW_MS of a small catalogue
    // made unsellable by an error we already know happened.
    try {
      await cancelReservedOrder(order.id);
    } catch (cleanupErr) {
      // The sweep is still the backstop, so a failed cleanup is recoverable.
      // What is not recoverable is hiding the error the caller needs to see,
      // so this is logged and swallowed rather than thrown.
      console.error("[orders] could not release a failed order's reservation", {
        orderId: order.id,
        cause: cleanupErr,
      });
    }
    throw err;
  }

  // Return the row as it stands AFTER the payment intent id is written.
  // Returning the pre-update `order` would hand the caller a row whose
  // stripePaymentIntentId is always null while the stored row has it set.
  const [withIntent] = await db
    .update(orders)
    .set({ stripePaymentIntentId: intent.paymentIntentId })
    .where(eq(orders.id, order.id))
    .returning();

  return { order: withIntent, clientSecret: intent.clientSecret };
}

/**
 * Undoes a committed reservation whose order can no longer proceed.
 *
 * Deliberately the same end state the expiry sweep produces — cancelled, with
 * the stock given back — so an order cleaned up here is indistinguishable from
 * one the sweep reclaimed, and nothing downstream needs a second case.
 */
async function cancelReservedOrder(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await releaseStock(tx, orderId);
    await tx
      .update(orders)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending")));
  });
}

/**
 * An order may only be reused while it is still pending with a live
 * reservation. Anything paid, failed, or already swept must start fresh —
 * reusing a paid order would let a second charge overwrite a real sale.
 */
async function findReusablePendingOrder(orderId: string): Promise<Order | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.status, "pending"),
        eq(orders.inventoryState, "reserved"),
      ),
    )
    .limit(1);

  return order ?? null;
}

/**
 * Thrown by `markOrderPaid` when a payment intent that Stripe says succeeded
 * has no matching order at all. This should be impossible in normal
 * operation, so we cannot silently swallow it: throwing rolls back the
 * `stripe_events` insert in the same transaction, which makes Stripe retry
 * the webhook and, if retries are exhausted, surfaces the event as failed in
 * the Stripe dashboard for manual reconciliation. A silent 200 here would
 * lose track of real money with no record anywhere.
 */
export class OrderNotFoundForPaymentError extends Error {
  constructor(public readonly paymentIntentId: string) {
    super(`No order found for payment intent ${paymentIntentId}`);
    this.name = "OrderNotFoundForPaymentError";
  }
}

/**
 * Thrown by `markOrderPaid` when the order matching a succeeded payment
 * intent exists but is not `pending` (e.g. it was cancelled by reservation
 * expiry while Stripe was completing a slow payment) and is not already
 * `paid` (which is the normal idempotent replay and returns `null` instead).
 * Throwing — rather than returning `null` — rolls back the `stripe_events`
 * insert in the same transaction, so Stripe retries the webhook instead of
 * treating a stranded charge as handled. That keeps the charge recoverable:
 * retries eventually surface it in the Stripe dashboard rather than letting
 * it vanish with no order, no email, and nothing to reconcile against.
 */
export class StrandedPaymentError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly paymentIntentId: string,
    public readonly status: string,
  ) {
    super(
      `Order ${orderId} for payment intent ${paymentIntentId} is in state "${status}", not pending`,
    );
    this.name = "StrandedPaymentError";
  }
}

/**
 * The only path that sets status 'paid'. Idempotent via the stripe_events
 * ledger — a replayed webhook returns null and changes nothing.
 */
export async function markOrderPaid(
  paymentIntentId: string,
  eventId: string,
): Promise<Order | null> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: eventId, type: "payment_intent.succeeded" })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });

    if (inserted.length === 0) return null; // Already processed.

    const [existing] = await tx
      .select()
      .from(orders)
      .where(eq(orders.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (!existing) {
      throw new OrderNotFoundForPaymentError(paymentIntentId);
    }

    // "fulfilled" is downstream of "paid": the order was paid and has since
    // shipped. A late or replayed succeeded-event for it is still a no-op, not
    // a stranded payment. Nothing sets "fulfilled" until the admin plan ships,
    // but treating it as stranded then would throw and retry forever.
    if (existing.status === "paid" || existing.status === "fulfilled") {
      // Another event already did the work — idempotent no-op.
      return null;
    }

    if (existing.status !== "pending") {
      throw new StrandedPaymentError(existing.id, paymentIntentId, existing.status);
    }

    const [order] = await tx
      .update(orders)
      .set({ status: "paid", paidAt: new Date() })
      .where(
        and(
          eq(orders.stripePaymentIntentId, paymentIntentId),
          eq(orders.status, "pending"),
        ),
      )
      .returning();

    if (!order) return null;

    await commitStock(tx, order.id);

    if (order.discountCodeId) {
      const recorded = await redeemDiscount(tx, order.discountCodeId);
      if (!recorded) {
        // The cap was exhausted by a concurrent order between checkout and
        // payment. The customer has already been charged the discounted
        // total, so we honour it and log the discrepancy rather than
        // throwing — a throw here would fail the webhook and have Stripe
        // retry a payment that already succeeded.
        console.warn("[orders] discount applied but not recorded", {
          orderId: order.id,
          discountCodeId: order.discountCodeId,
        });
      }
    }

    return order;
  });
}

/**
 * Looks up an order the caller has already proved access to, by matching the
 * order number against a set of order ids granted to this browser.
 *
 * The id filter is part of the WHERE clause rather than a check on the result,
 * so there is no code path here that reads an order without a credential.
 * An empty grant list short-circuits: `inArray(x, [])` is an SQL no-op in some
 * dialects, and "no credentials" must never mean "no filter".
 */
export async function findOrderByNumberForIds(
  orderNumber: number,
  allowedOrderIds: string[],
): Promise<OrderWithItems | null> {
  if (allowedOrderIds.length === 0) return null;

  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.orderNumber, orderNumber),
        inArray(orders.id, allowedOrderIds),
      ),
    )
    .limit(1);

  if (!order) return null;

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  return { ...order, items };
}

export async function findOrderByNumber(
  orderNumber: number,
  email: string,
): Promise<OrderWithItems | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.orderNumber, orderNumber),
        sql`LOWER(${orders.email}) = LOWER(${email})`,
      ),
    )
    .limit(1);

  if (!order) return null;

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  return { ...order, items };
}

export async function findOrderById(id: string): Promise<OrderWithItems | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) return null;

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  return { ...order, items };
}
