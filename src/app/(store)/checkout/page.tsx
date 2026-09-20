import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCartId, getCartLines } from "@/lib/cart";
import { CheckoutForm } from "./CheckoutForm";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage() {
  const cartId = await getCartId();
  const lines = cartId ? await getCartLines(cartId) : [];
  if (lines.length === 0) redirect("/cart");

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Checkout</h1>
      <CheckoutForm />
    </div>
  );
}
