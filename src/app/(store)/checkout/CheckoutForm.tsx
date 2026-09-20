"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { formatCents } from "@/lib/money";
import { startCheckoutAction, type CheckoutState } from "./actions";
import styles from "./page.module.css";

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
);

/**
 * Hexes are duplicated from tokens.css because the Payment Element renders in
 * a cross-origin iframe and cannot read our CSS custom properties. Keep these
 * in step with the tokens: text-bright, panel, text-dim, line-bright, danger.
 */
const appearance = {
  theme: "night" as const,
  variables: {
    colorPrimary: "#d2d5da",
    colorBackground: "#17171b",
    colorText: "#d2d5da",
    colorTextSecondary: "#8d9198",
    colorTextPlaceholder: "#8d9198",
    colorDanger: "#e0645c",
    borderRadius: "2px",
    fontFamily: "system-ui, sans-serif",
  },
  rules: {
    ".Input": { border: "1px solid #65666e" },
  },
};

export function CheckoutForm() {
  const [state, action, pending] = useActionState<CheckoutState, FormData>(
    startCheckoutAction,
    { status: "idle" },
  );

  if (state.status === "ready") {
    return (
      <Elements
        stripe={stripePromise}
        options={{ clientSecret: state.clientSecret, appearance }}
      >
        <PaymentStep
          orderNumber={state.orderNumber}
          email={state.email}
          totalCents={state.totalCents}
        />
      </Elements>
    );
  }

  const fieldErrors = state.status === "error" ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={action} className={styles.form}>
      {state.status === "error" && !state.fieldErrors && (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      )}

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={fieldErrors.email}
      />
      <Field
        label="Full name"
        name="name"
        autoComplete="name"
        required
        error={fieldErrors.name}
      />
      <Field
        label="Address"
        name="line1"
        autoComplete="address-line1"
        required
        error={fieldErrors.line1}
      />
      <Field
        label="Apt, suite (optional)"
        name="line2"
        autoComplete="address-line2"
      />
      <Field
        label="City"
        name="city"
        autoComplete="address-level2"
        required
        error={fieldErrors.city}
      />
      <Field
        label="State"
        name="state"
        autoComplete="address-level1"
        maxLength={2}
        required
        error={fieldErrors.state}
      />
      <Field
        label="ZIP"
        name="postalCode"
        autoComplete="postal-code"
        inputMode="numeric"
        required
        error={fieldErrors.postalCode}
      />

      <p className={styles.shippingNote}>
        We ship ground within the US only. Fragrance cannot travel by air.
      </p>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Calculating" : "Continue to payment"}
      </Button>
    </form>
  );
}

function PaymentStep({
  orderNumber,
  email,
  totalCents,
}: {
  orderNumber: number;
  email: string;
  totalCents: number;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // No email in the URL: access is carried by the httpOnly cookie the
  // checkout action set, so the confirmation page keeps the customer's
  // address out of browser history, access logs and referrer headers.
  const confirmationUrl = `/order/${orderNumber}`;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    setError(null);

    const result = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}${confirmationUrl}`,
      },
      redirect: "if_required",
    });

    if (result.error) {
      // A declined card leaves the PaymentIntent reusable, so drop back into
      // the form rather than tearing the Element down.
      setError(result.error.message ?? "Payment failed. Try another card.");
      setSubmitting(false);
      return;
    }

    // replace, not push: the back button must not return to a checkout form
    // for an order that has already been paid. refresh re-renders the shared
    // store layout so the header's cart count reflects the cleared cart.
    router.replace(confirmationUrl);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className={styles.paymentForm}>
      <div className={styles.summary}>
        <p className={styles.total}>Total {formatCents(totalCents)}</p>
        <p className={styles.receiptNote}>A receipt will go to {email}.</p>
      </div>

      <PaymentElement />

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={!stripe || submitting}>
        {submitting ? "Processing" : `Pay ${formatCents(totalCents)}`}
      </Button>
    </form>
  );
}
