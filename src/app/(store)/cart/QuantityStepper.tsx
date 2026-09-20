"use client";

import { useOptimistic } from "react";
import { MAX_LINE_QUANTITY } from "@/lib/cart/limits";
import { setQuantityAction } from "../actions";
import styles from "./page.module.css";

/**
 * Per-line quantity control.
 *
 * Every control is a submit button carrying the quantity it would produce, so
 * the form still works with JavaScript disabled — the rest of the store is
 * built on Server Components and form actions, and this should not be the one
 * control that silently does nothing without JS.
 *
 * Optimism stops at the integer count. Line totals and the cart summary come
 * from quote() on the server, because a second money implementation on the
 * client can silently disagree with the first.
 */
export function QuantityStepper({
  productId,
  name,
  quantity,
}: {
  productId: string;
  name: string;
  quantity: number;
}) {
  const [optimisticQuantity, setOptimisticQuantity] = useOptimistic(quantity);

  // While an update is in flight the optimistic count is ahead of the prop;
  // once the server responds and the page re-renders they agree again.
  //
  // Do NOT use useTransition's isPending here. A form action already runs in a
  // transition, so the hook's flag reads false on every render — measured, not
  // assumed — and the dimming would never appear.
  const isPending = optimisticQuantity !== quantity;

  async function submit(formData: FormData) {
    // The clicked button supplies the target quantity. A form action is
    // already a transition, so the optimistic update needs no extra wrapping.
    const next = Number(formData.get("quantity"));
    if (Number.isInteger(next)) setOptimisticQuantity(next);
    await setQuantityAction(formData);
  }

  return (
    <form action={submit} className={styles.qtyForm}>
      <input type="hidden" name="productId" value={productId} />

      <div className={`${styles.stepper} ${isPending ? styles.pending : ""}`}>
        <button
          type="submit"
          name="quantity"
          value={quantity - 1}
          className={styles.stepButton}
          // Stops a fast decrement run from deleting the line. Removal is a
          // separate, deliberate control.
          disabled={quantity <= 1}
          aria-label={`One fewer ${name}`}
        >
          −
        </button>

        <span className={styles.count} aria-live="polite">
          {optimisticQuantity}
        </span>

        <button
          type="submit"
          name="quantity"
          value={quantity + 1}
          className={styles.stepButton}
          disabled={quantity >= MAX_LINE_QUANTITY}
          aria-label={`One more ${name}`}
        >
          +
        </button>
      </div>

      <button
        type="submit"
        name="quantity"
        value={0}
        className={styles.remove}
        aria-label={`Remove ${name}`}
      >
        Remove
      </button>
    </form>
  );
}
