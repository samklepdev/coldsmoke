import type { Order } from "@/lib/db/schema";
import { getPayments } from "@/lib/payments";
import { markOrderPaid } from "./index";
import { completePaidOrder } from "./completePaid";

/**
 * The ledger key reconciliation writes to `stripe_events`.
 *
 * Namespaced away from real Stripe event ids, which begin "evt_", so the two
 * paths cannot collide in the ledger and each still blocks the other from
 * doing the work twice. It doubles as a metric: `reconcile:` rows are orders
 * whose webhook never landed, and a growing count means webhook delivery
 * itself needs fixing rather than compensating for.
 */
export function reconcileEventId(paymentIntentId: string): string {
  return `reconcile:${paymentIntentId}`;
}

/**
 * Asks Stripe whether a pending order was in fact paid, and completes it if so.
 *
 * The webhook is the normal path and this changes nothing about it. This exists
 * because the webhook is the ONLY path: a delivery that never arrives leaves a
 * charged customer looking at an unpaid order, with no confirmation email, no
 * committed stock, and a cart still holding what they just bought. That
 * happened -- order 1030, $51.00 captured, status pending.
 *
 * Returns true only when THIS call transitioned the order, so the caller knows
 * to re-read it.
 *
 * Never throws. It runs during a page render, and a Stripe outage must degrade
 * to "still Awaiting payment" rather than a 500 on the page where a customer is
 * trying to find out whether they were charged.
 */
export async function reconcilePendingOrder(order: Order): Promise<boolean> {
  if (order.status !== "pending") return false;
  if (!order.stripePaymentIntentId) return false;

  const paymentIntentId = order.stripePaymentIntentId;

  try {
    const status = await getPayments().getIntentStatus(paymentIntentId);
    // Only "succeeded" is acted on. A failed or cancelled payment is
    // handleFailure's job, and "processing" has not resolved yet.
    if (status !== "succeeded") return false;

    // No pre-check on the order's status and no lock: markOrderPaid inserts
    // the key and re-reads the order inside one transaction, returning null if
    // either the key or a paid status is already there. Whichever of webhook
    // and reconciliation arrives second gets null and skips the side effects,
    // so the confirmation email cannot go twice.
    const paid = await markOrderPaid(
      paymentIntentId,
      reconcileEventId(paymentIntentId),
    );
    if (!paid) return false;

    await completePaidOrder(paid.id, paid.cartId);
    return true;
  } catch (error) {
    console.error("[reconcile] could not reconcile order", {
      orderId: order.id,
      paymentIntentId,
      error,
    });
    return false;
  }
}
