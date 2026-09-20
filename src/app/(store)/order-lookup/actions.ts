"use server";

import { redirect } from "next/navigation";
import { findOrderByNumber, parseOrderNumber } from "@/lib/orders";

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

  redirect(`/order/${order.orderNumber}?email=${encodeURIComponent(email)}`);
}
