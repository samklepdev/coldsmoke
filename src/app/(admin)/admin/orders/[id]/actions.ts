"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdminUser } from "@/lib/auth/session";
import { findOrderById } from "@/lib/orders";
import { fulfillOrder } from "@/lib/orders/fulfill";
import { sendShippingConfirmation } from "@/lib/email/shipping";
import {
  OrderNotFoundError,
  OrderNotFulfillableError,
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

/** Sends the shipping confirmation again for an order already fulfilled. */
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

  const { delivered } = await sendShippingConfirmation(order);

  return { status: delivered ? "fulfilled" : "fulfilled-undelivered" };
}
