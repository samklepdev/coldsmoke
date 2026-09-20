import { getResend, EMAIL_FROM } from "./client";
import { OrderConfirmation } from "./OrderConfirmation";
import { formatOrderNumber } from "@/lib/orders/format";
import type { OrderWithItems } from "@/lib/orders";

/**
 * Never throws. The payment already succeeded by the time this runs — a failed
 * email must not fail the webhook and trigger a Stripe retry.
 */
export async function sendOrderConfirmation(
  order: OrderWithItems,
): Promise<void> {
  try {
    await getResend().emails.send({
      from: EMAIL_FROM,
      to: order.email,
      subject: `Coldsmoke order ${formatOrderNumber(order.orderNumber)}`,
      react: <OrderConfirmation order={order} />,
    });
  } catch (error) {
    console.error("[email] order confirmation failed", {
      orderId: order.id,
      error,
    });
  }
}
