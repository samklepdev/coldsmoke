import { findOrderById } from "./index";
import { sendOrderConfirmation } from "@/lib/email";
import { clearCart } from "@/lib/cart";

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
 * What is NOT true is that these effects get retried. Nothing re-runs them:
 * reconcilePendingOrder exits at `status !== "pending"`, and by the time this
 * catch can fire markOrderPaid has already committed `paid`. So a failure here
 * is permanent and needs manual intervention — and because clearCart runs
 * first, a failure in it means the confirmation email is never even attempted.
 * Do not write a reassuring comment here again without a mechanism behind it;
 * making this recoverable needs a `completedAt` column so a later pass can tell
 * "paid" from "paid and finished".
 *
 * Lives here rather than in the webhook route because it has two callers. A
 * second copy inside reconciliation is exactly how "what happens after
 * payment" starts meaning two different things.
 */
export async function completePaidOrder(
  orderId: string,
  cartId: string | null,
): Promise<void> {
  try {
    // Empty the cart that produced this order. The webhook is the
    // authoritative "payment succeeded" signal — clearing client-side after
    // confirmPayment would leave a full cart behind whenever the customer
    // closes the tab, letting them re-purchase by accident.
    if (cartId) await clearCart(cartId);

    const full = await findOrderById(orderId);
    if (full) await sendOrderConfirmation(full);
  } catch (error) {
    console.error("[payments] post-payment side effects failed", {
      orderId,
      error,
    });
  }
}
