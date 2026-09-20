"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  getOrCreateCartId,
  addItem,
  setQuantity,
  MAX_LINE_QUANTITY,
} from "@/lib/cart";

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
