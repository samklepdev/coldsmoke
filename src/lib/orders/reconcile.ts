import type { Order } from "@/lib/db/schema";
import { getPayments } from "@/lib/payments";
import {
  markOrderPaid,
  OrderNotFoundForPaymentError,
  StrandedPaymentError,
} from "./index";
import { completePaidOrder } from "./completePaid";

/**
 * The ledger key reconciliation writes to `stripe_events`.
 *
 * Namespaced away from real Stripe event ids, which begin "evt_", so the key
 * spaces cannot collide. Note what this does and does not buy: because the keys
 * are DISTINCT, they do not block each other -- a webhook and a reconciliation
 * for the same order both insert successfully. What makes the second one a
 * no-op is markOrderPaid's conditional update (`... AND status = 'pending'`)
 * returning no row. Do not "simplify" that guard away on the theory that the
 * ledger key already covers it.
 *
 * It doubles as a rough metric: a growing count of `reconcile:` rows means
 * webhook delivery itself needs fixing rather than compensating for. Rough
 * because a row is written whenever reconciliation reaches markOrderPaid,
 * including when the webhook won the race and the update matched nothing.
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
 * Returns true only when THIS call transitioned the order. The caller should
 * redirect rather than re-read in place: completing the order also empties the
 * cart, and anything rendered above this point (the layout's cart count) was
 * read before that happened.
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
    // Money-without-an-order gets its own tag. The webhook turns these two into
    // a non-2xx so Stripe retries and they surface in the dashboard; here there
    // is no retry and no dashboard, so reconciliation is the only thing that
    // ever sees them. Logged identically to a network blip they would be
    // invisible, and they are not recoverable once the stock is released.
    if (
      error instanceof StrandedPaymentError ||
      error instanceof OrderNotFoundForPaymentError
    ) {
      console.error("[reconcile][stranded-payment] captured money has no payable order", {
        orderId: order.id,
        paymentIntentId,
        error,
      });
      return false;
    }

    console.error("[reconcile] could not reconcile order", {
      orderId: order.id,
      paymentIntentId,
      error,
    });
    return false;
  }
}
