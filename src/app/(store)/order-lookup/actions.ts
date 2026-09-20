"use server";

import { redirect } from "next/navigation";
import { findOrderByNumber, parseOrderNumber } from "@/lib/orders";
import { grantOrderAccess } from "@/lib/orders/access";

export type LookupState = { error?: string };

export async function lookupOrderAction(
  _prev: LookupState,
  formData: FormData,
): Promise<LookupState> {
  const rawNumber = String(formData.get("orderNumber") ?? "");
  const email = String(formData.get("email") ?? "").trim();

  const orderNumber = parseOrderNumber(rawNumber);
  if (orderNumber === null || !email) {
    return { error: "Enter your order number and the email you used." };
  }

  const order = await findOrderByNumber(orderNumber, email);
  if (!order) {
    // Deliberately vague — do not confirm whether an order number exists.
    return { error: "We couldn't find that order. Check both fields." };
  }

  // The email proved ownership here; from now on the cookie carries it, so
  // the address never has to travel in a URL.
  await grantOrderAccess(order.id);

  redirect(`/order/${order.orderNumber}`);
}
