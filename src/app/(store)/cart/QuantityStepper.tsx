"use client";

import { useFormStatus } from "react-dom";
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
 * `setQuantityAction` is passed to `action` DIRECTLY rather than wrapped in a
 * client function. Next only emits the native form POST (method, URL, hidden
 * action id) when it can see a Server Action here; wrapping it in a local
 * async function to drive `useOptimistic` — which is what React's own
 * useOptimistic example does — leaves a form that submits nowhere without
 * JavaScript. That was measured with a JS-disabled browser, not assumed: `+`
 * did nothing at all.
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
  return (
    <form action={setQuantityAction} className={styles.qtyForm}>
      <input type="hidden" name="productId" value={productId} />
      <StepperControls name={name} quantity={quantity} />
    </form>
  );
}

/**
 * Split out because `useFormStatus` only reports on a form it is rendered
 * inside — called in the component that owns the <form> it would always read
 * idle.
 */
function StepperControls({
  name,
  quantity,
}: {
  name: string;
  quantity: number;
}) {
  const { pending, data } = useFormStatus();

  // The in-flight FormData carries the clicked button's value, so the count
  // can move the instant a button is pressed without a second source of truth.
  // Once the server responds the form goes idle and `quantity` — the freshly
  // revalidated prop — takes over again.
  const submitted = pending ? Number(data?.get("quantity")) : Number.NaN;
  const shown = Number.isInteger(submitted) ? submitted : quantity;

  return (
    <>
      <div className={`${styles.stepper} ${pending ? styles.pending : ""}`}>
        <button
          type="submit"
          name="quantity"
          value={shown - 1}
          className={styles.stepButton}
          // Stops a fast decrement run from deleting the line. Removal is a
          // separate, deliberate control.
          disabled={shown <= 1}
          aria-label={`One fewer ${name}`}
        >
          −
        </button>

        <span className={styles.count} aria-live="polite">
          {shown}
        </span>

        <button
          type="submit"
          name="quantity"
          value={shown + 1}
          className={styles.stepButton}
          disabled={shown >= MAX_LINE_QUANTITY}
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
    </>
  );
}
