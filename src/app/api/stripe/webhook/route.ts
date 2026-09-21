import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, stripeEvents } from "@/lib/db/schema";
import { getPayments } from "@/lib/payments";
import { markOrderPaid, findOrderById } from "@/lib/orders";
import { recordRefund } from "@/lib/orders/refund";
import { sendOrderConfirmation } from "@/lib/email";
import { clearCart } from "@/lib/cart";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  // The raw body is required for signature verification — do not parse first.
  const rawBody = await request.text();

  let event;
  try {
    event = getPayments().verifyWebhook(rawBody, signature);
  } catch (error) {
    console.error("[webhook] signature verification failed", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        if (!event.paymentIntentId) break;

        // markOrderPaid owns idempotency via the stripe_events ledger; null
        // means this event was already processed.
        const order = await markOrderPaid(event.paymentIntentId, event.id);
        if (order) await completePaidOrder(order.id, order.cartId);
        break;
      }

      case "payment_intent.payment_failed": {
        if (!event.paymentIntentId) break;
        await handleFailure(event.id, event.paymentIntentId);
        break;
      }

      case "charge.refunded": {
        if (!event.paymentIntentId || event.amountCents === null) {
          // Acknowledged rather than retried: a refund we cannot tie to a
          // payment intent will not become tieable on a second delivery, so
          // a non-2xx would just retry forever. But it is real money moving
          // with no order we can find, so it must not pass in silence.
          console.error("[webhook] charge.refunded without a usable intent", {
            eventId: event.id,
            paymentIntentId: event.paymentIntentId,
            amountCents: event.amountCents,
          });
          break;
        }

        // amountCents is amount_refunded -- the cumulative total for the
        // charge, which is why recordRefund sets rather than accumulates.
        // Letting this throw is deliberate: it produces a non-2xx, rolls back
        // the ledger row, and has Stripe retry. Money that moved with no
        // order behind it must never be answered with a 200.
        await recordRefund(event.paymentIntentId, event.id, event.amountCents);
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    // Non-2xx makes Stripe retry, which the idempotency ledger makes safe.
    //
    // DO NOT narrow this catch or convert it to a 200. markOrderPaid throws
    // StrandedPaymentError and OrderNotFoundForPaymentError precisely so they
    // reach here and produce a non-2xx: throwing rolls back the stripe_events
    // insert, so Stripe retries and eventually surfaces the event in its
    // dashboard. Swallowing them returns 200 for a real charge that has no
    // order behind it, and the money is then lost with nothing to reconcile.
    console.error("[webhook] handler failed", { type: event.type, error });
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }
}

/**
 * Side effects that run after the payment has already been committed.
 *
 * These are deliberately isolated from the caller's catch. By the time we get
 * here markOrderPaid's transaction has COMMITTED: the order is paid, the stock
 * is committed, and the event id is durably in the ledger. Letting a failure
 * here escape would return 500 for a payment that actually succeeded, and the
 * retry Stripe then sends is a no-op — markOrderPaid sees the event already
 * processed and returns null — so the side effects never run anyway and the
 * only lasting result is a permanently failing event in the dashboard.
 *
 * Both effects are recoverable by other means: a stale cart is corrected on
 * the customer's next visit, and a missing confirmation email can be resent.
 */
async function completePaidOrder(
  orderId: string,
  cartId: string | null,
): Promise<void> {
  try {
    // Empty the cart that produced this order. The webhook is the only
    // authoritative "payment succeeded" signal — clearing client-side after
    // confirmPayment would leave a full cart behind whenever the customer
    // closes the tab, letting them re-purchase by accident.
    if (cartId) await clearCart(cartId);

    const full = await findOrderById(orderId);
    if (full) await sendOrderConfirmation(full);
  } catch (error) {
    console.error("[webhook] post-payment side effects failed", {
      orderId,
      error,
    });
  }
}

async function handleFailure(eventId: string, paymentIntentId: string) {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: eventId, type: "payment_intent.payment_failed" })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });

    if (inserted.length === 0) return;

    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (!order || order.status !== "pending") return;

    // Deliberately does NOT change status or release stock.
    //
    // A declined card is not the end of the checkout — the customer is still
    // on the page and Stripe lets them retry the SAME PaymentIntent with
    // another card. Three things would break if we mutated here:
    //
    //   1. Releasing the reservation lets someone else take the last bottle
    //      while the customer is typing a second card number.
    //   2. markOrderPaid only transitions orders that are still `pending`,
    //      so a successful retry on this PaymentIntent would find nothing to
    //      mark paid — the customer gets charged and no order is recorded.
    //   3. createPendingOrder only reuses orders that are `pending` with a
    //      live reservation, so a retry would strand this order entirely.
    //
    // The reservation expires on its own 15-minute schedule, and the sweep in
    // releaseExpiredReservations cancels the order then. That is the only
    // path that should retire an unpaid order.
    console.warn("[webhook] payment failed, order left pending for retry", {
      orderId: order.id,
      paymentIntentId,
    });
  });
}
