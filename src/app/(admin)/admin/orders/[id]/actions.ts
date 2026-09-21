"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdminUser } from "@/lib/auth/session";
import { findOrderById } from "@/lib/orders";
import { fulfillOrder } from "@/lib/orders/fulfill";
import { refundOrder } from "@/lib/orders/refund";
import { sendShippingConfirmation } from "@/lib/email/shipping";
import {
  OrderNotFoundError,
  OrderNotFulfillableError,
  OrderNotRefundableError,
} from "@/lib/orders/errors";

const schema = z.object({
  orderId: z.uuid(),
  carrier: z.string().trim().min(1, "Name the carrier."),
  trackingNumber: z.string().trim().min(1, "Enter the tracking number."),
});

export type FulfillState =
  | { status: "idle" }
  | { status: "fulfilled" }
  /** Shipped, but the customer was not told. */
  | { status: "fulfilled-undelivered" }
  | { status: "error"; error: string };

/**
 * Marks an order shipped, then tries to tell the customer.
 *
 * The layout already gates /admin, but a Server Action is its own entry
 * point: it is reachable by POST without the layout ever rendering. So the
 * check is repeated here rather than inherited.
 */
export async function fulfillAction(
  _prev: FulfillState,
  formData: FormData,
): Promise<FulfillState> {
  await requireAdminUser();

  const parsed = schema.safeParse({
    orderId: formData.get("orderId"),
    carrier: formData.get("carrier"),
    trackingNumber: formData.get("trackingNumber"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      error: parsed.error.issues[0]?.message ?? "Check the fields.",
    };
  }

  try {
    await fulfillOrder(parsed.data);
  } catch (error) {
    if (
      error instanceof OrderNotFulfillableError ||
      error instanceof OrderNotFoundError
    ) {
      return { status: "error", error: error.message };
    }
    throw error;
  }

  revalidatePath(`/admin/orders/${parsed.data.orderId}`);

  /**
   * The order is already fulfilled by this point, and nothing below may undo
   * it. The parcel shipped whether or not Resend accepted the message, so a
   * rejected send is reported to the admin -- who can resend -- rather than
   * rolled back or swallowed.
   */
  const order = await findOrderById(parsed.data.orderId);
  if (!order) return { status: "fulfilled" };

  const { delivered } = await sendShippingConfirmation(order);

  return { status: delivered ? "fulfilled" : "fulfilled-undelivered" };
}

/**
 * Sends the shipping confirmation again for an order already fulfilled.
 *
 * The fulfilled check is not decoration. This is a Server Action, so it is
 * reachable by POST against any order id; without it, an order that has not
 * shipped would be emailed "your order is on its way" with a blank carrier
 * and tracking number, because those columns are only written by fulfillOrder.
 */
export async function resendShippingAction(
  _prev: FulfillState,
  formData: FormData,
): Promise<FulfillState> {
  await requireAdminUser();

  const orderId = z.uuid().safeParse(formData.get("orderId"));
  if (!orderId.success) {
    return { status: "error", error: "Unknown order." };
  }

  const order = await findOrderById(orderId.data);
  if (!order) return { status: "error", error: "Unknown order." };

  if (order.status !== "fulfilled" || !order.carrier || !order.trackingNumber) {
    return {
      status: "error",
      error: "That order has not shipped, so there is no shipping email to resend.",
    };
  }

  const { delivered } = await sendShippingConfirmation(order);

  return { status: delivered ? "fulfilled" : "fulfilled-undelivered" };
}

export type RefundState =
  | { status: "idle" }
  /** Sent to Stripe. The order does not change until charge.refunded lands. */
  | { status: "submitted"; amountCents: number }
  | { status: "error"; error: string };

/**
 * Sends the refund and reports only that it was sent.
 *
 * The order still reads "paid" or "fulfilled" afterwards, because the webhook
 * has not arrived yet. That is honest rather than sloppy: the refund is not
 * final until Stripe says so, and writing the status here would make this a
 * second writer that could disagree with the webhook about the same order.
 */
export async function refundAction(
  _prev: RefundState,
  formData: FormData,
): Promise<RefundState> {
  await requireAdminUser();

  const orderId = z.uuid().safeParse(formData.get("orderId"));
  if (!orderId.success) {
    return { status: "error", error: "Unknown order." };
  }

  try {
    const { amountCents } = await refundOrder({ orderId: orderId.data });
    revalidatePath(`/admin/orders/${orderId.data}`);
    return { status: "submitted", amountCents };
  } catch (error) {
    if (
      error instanceof OrderNotRefundableError ||
      error instanceof OrderNotFoundError
    ) {
      return { status: "error", error: error.message };
    }
    throw error;
  }
}
