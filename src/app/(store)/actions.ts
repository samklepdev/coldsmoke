"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  getCartId,
  getOrCreateCartId,
  getCartLines,
  addItem,
  setQuantity,
  MAX_LINE_QUANTITY,
} from "@/lib/cart";
import { quote } from "@/lib/pricing/quote";
import { DISCOUNT_COOKIE } from "@/lib/cookies";
import {
  lookupDiscount,
  validateDiscount,
  discountFailureMessage,
} from "@/lib/discounts";

/**
 * Form values are strings and can be anything a client chooses to send. An
 * empty input yields Number("") === 0, and addItem/setQuantity throw on values
 * that are not integers in range — which would escape a Server Action as an
 * unhandled error. Coerce here and let the caller decide the fallback.
 */
function parseQuantity(raw: FormDataEntryValue | null, min: number): number | null {
  if (typeof raw !== "string") return null;

  // Number("") and Number("  ") are both 0. Without this guard a blank box
  // would parse as an explicit zero, which on the cart page means "remove this
  // line" — a cleared field must not silently delete anything.
  if (raw.trim() === "") return null;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < min || parsed > MAX_LINE_QUANTITY) return null;
  return parsed;
}

export async function addToCartAction(formData: FormData): Promise<void> {
  const productId = String(formData.get("productId") ?? "");
  // A missing or malformed quantity means "one of these, please".
  const quantity = parseQuantity(formData.get("quantity"), 1) ?? 1;

  if (!productId) throw new Error("Missing productId");

  const cartId = await getOrCreateCartId();
  await addItem(cartId, productId, quantity);

  revalidatePath("/cart");
  redirect("/cart");
}

export async function setQuantityAction(formData: FormData): Promise<void> {
  const productId = String(formData.get("productId") ?? "");
  // 0 is meaningful here — it removes the line.
  const quantity = parseQuantity(formData.get("quantity"), 0);

  // Garbage in the box shouldn't silently delete the line; re-render instead,
  // which restores the stored quantity.
  if (quantity === null) {
    revalidatePath("/cart");
    return;
  }

  const cartId = await getOrCreateCartId();
  await setQuantity(cartId, productId, quantity);

  revalidatePath("/cart");
}

export type DiscountFormState = { error?: string; applied?: string };

export async function applyDiscountAction(
  _prev: DiscountFormState,
  formData: FormData,
): Promise<DiscountFormState> {
  const raw = String(formData.get("code") ?? "");
  const jar = await cookies();

  // An empty submission clears whatever code was applied.
  if (!raw.trim()) {
    jar.delete(DISCOUNT_COOKIE);
    revalidatePath("/cart");
    return {};
  }

  const cartId = await getOrCreateCartId();
  const lines = await getCartLines(cartId);
  const { subtotalCents } = quote(lines);

  const code = await lookupDiscount(raw);
  const result = validateDiscount(code, subtotalCents);

  if (!result.ok) {
    // Rejecting a new code also drops any previously applied one, so the page
    // has to re-render or the totals keep showing a discount that is now gone.
    jar.delete(DISCOUNT_COOKIE);
    revalidatePath("/cart");
    return { error: discountFailureMessage(result.reason, code ?? undefined) };
  }

  jar.set(DISCOUNT_COOKIE, result.discount.code, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });

  revalidatePath("/cart");
  return { applied: result.discount.code };
}

/**
 * Shared by the cart and checkout pages so both price identically. Read-only
 * on purpose — it runs during Server Component render, where setting a cookie
 * would throw.
 *
 * Re-validates against the current subtotal on every call, so a code that
 * needed a $50 order stops applying by itself once the cart drops below it.
 */
export async function getActiveDiscount() {
  const jar = await cookies();
  const stored = jar.get(DISCOUNT_COOKIE)?.value;
  if (!stored) return null;

  const cartId = await getCartId();
  if (!cartId) return null;
  const lines = await getCartLines(cartId);
  const { subtotalCents } = quote(lines);

  const code = await lookupDiscount(stored);
  const result = validateDiscount(code, subtotalCents);
  return result.ok ? result.discount : null;
}
