"use server";

import { z } from "zod";
import { cookies } from "next/headers";
import { getOrCreateCartId, getCartLines, setQuantity } from "@/lib/cart";
import { getCatalogProductById } from "@/lib/catalog";
import { createPendingOrder } from "@/lib/orders";
import { OutOfStockError } from "@/lib/inventory";
import { PENDING_ORDER_COOKIE } from "@/lib/cookies";
import { getActiveDiscount } from "../actions";
import type { Address } from "@/lib/db/schema";

const addressSchema = z.object({
  email: z.email("Enter a valid email address."),
  name: z.string().trim().min(1, "Enter a name."),
  line1: z.string().trim().min(1, "Enter a street address."),
  // An untouched optional input still posts "", which would otherwise be
  // stored as a blank second address line.
  line2: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  city: z.string().trim().min(1, "Enter a city."),
  // Letters only, and normalised: Stripe Tax expects a canonical state code,
  // and a plain length check would accept "12" or pass "tx" through as typed.
  state: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter state code.")
    .transform((value) => value.toUpperCase()),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "Enter a valid ZIP code."),
});

export type CheckoutState =
  | { status: "idle" }
  | { status: "error"; error: string; fieldErrors?: Record<string, string> }
  | {
      status: "ready";
      clientSecret: string;
      orderNumber: number;
      email: string;
      totalCents: number;
    };

export async function startCheckoutAction(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const parsed = addressSchema.safeParse(Object.fromEntries(formData));

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return {
      status: "error",
      error: "Check the highlighted fields.",
      fieldErrors,
    };
  }

  const { email, ...rest } = parsed.data;
  const shippingAddress: Address = { ...rest, country: "US" };

  const cartId = await getOrCreateCartId();
  const lines = await getCartLines(cartId);
  if (lines.length === 0) {
    return { status: "error", error: "Your cart is empty." };
  }

  const discount = await getActiveDiscount();

  // Reuse any pending order from an earlier submit on this checkout, so
  // editing an address updates one reservation instead of stacking another.
  // A stale or already-paid id is safe: createPendingOrder verifies the order
  // is still pending with a live reservation before reusing it.
  const jar = await cookies();
  const existingOrderId = jar.get(PENDING_ORDER_COOKIE)?.value ?? null;

  try {
    const { order, clientSecret } = await createPendingOrder({
      cartLines: lines,
      cartId,
      email,
      shippingAddress,
      discount,
      existingOrderId,
    });

    jar.set(PENDING_ORDER_COOKIE, order.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 30,
    });

    return {
      status: "ready",
      clientSecret,
      orderNumber: order.orderNumber,
      email: order.email,
      totalCents: order.totalCents,
    };
  } catch (error) {
    if (error instanceof OutOfStockError) {
      // The spec requires a specific message naming the product, and the cart
      // corrected to what is actually available — a generic "something sold
      // out" leaves the customer to guess which line to fix.
      const product = await getCatalogProductById(error.productId);

      if (!product) {
        return {
          status: "error",
          error: "An item in your cart is no longer available. Check your cart.",
        };
      }

      await setQuantity(cartId, product.id, product.available);

      return {
        status: "error",
        error:
          product.available === 0
            ? `${product.name} just sold out. We removed it from your cart.`
            : `Only ${product.available} left of ${product.name}. We updated your cart.`,
      };
    }
    // Stripe Tax failures land here. Blocking is deliberate: charging a guessed
    // tax amount is worse than asking the customer to retry.
    console.error("[checkout] failed to start", error);
    return {
      status: "error",
      error: "We couldn't start checkout. Try again in a moment.",
    };
  }
}
