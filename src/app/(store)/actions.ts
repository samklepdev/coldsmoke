"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOrCreateCartId, addItem, setQuantity } from "@/lib/cart";

export async function addToCartAction(formData: FormData): Promise<void> {
  const productId = String(formData.get("productId") ?? "");
  const quantity = Number(formData.get("quantity") ?? 1);

  if (!productId) throw new Error("Missing productId");

  const cartId = await getOrCreateCartId();
  await addItem(cartId, productId, Number.isFinite(quantity) ? quantity : 1);

  revalidatePath("/cart");
  redirect("/cart");
}

export async function setQuantityAction(formData: FormData): Promise<void> {
  const productId = String(formData.get("productId") ?? "");
  const quantity = Number(formData.get("quantity") ?? 0);

  const cartId = await getOrCreateCartId();
  await setQuantity(cartId, productId, quantity);

  revalidatePath("/cart");
}
