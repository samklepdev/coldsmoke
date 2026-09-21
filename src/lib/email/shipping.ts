import { getResend, EMAIL_FROM } from "./client";
import { ShippingConfirmation } from "./ShippingConfirmation";
import { formatOrderNumber } from "@/lib/orders/format";
import type { OrderWithItems } from "@/lib/orders";

/**
 * Never throws, and never reports a delivery that did not happen.
 *
 * Both halves matter, for different reasons than the order confirmation. A
 * throw here would surface to the admin as a failed fulfilment for a parcel
 * that really did ship. And Resend signals a rejected message by RETURNING
 * { data: null, error } rather than throwing, so the returned error has to be
 * inspected -- a try/catch alone tells the admin the customer was notified
 * when they were not.
 */
export async function sendShippingConfirmation(
  order: OrderWithItems,
): Promise<{ delivered: boolean }> {
  try {
    const { error } = await getResend().emails.send({
      from: EMAIL_FROM,
      to: order.email,
      subject: `Coldsmoke order ${formatOrderNumber(order.orderNumber)} has shipped`,
      react: ShippingConfirmation({ order }),
    });

    if (error) {
      console.error("[email] shipping confirmation rejected", {
        orderId: order.id,
        cause: error,
      });
      return { delivered: false };
    }

    return { delivered: true };
  } catch (cause) {
    console.error("[email] shipping confirmation threw", {
      orderId: order.id,
      cause,
    });
    return { delivered: false };
  }
}
