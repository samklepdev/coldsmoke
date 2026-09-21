"use client";

import { useActionState } from "react";
import {
  fulfillAction,
  resendShippingAction,
  type FulfillState,
} from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

export function FulfillForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState<FulfillState, FormData>(
    fulfillAction,
    { status: "idle" },
  );

  if (state.status === "fulfilled") {
    return <p role="status">Marked as shipped. The customer has been emailed.</p>;
  }

  if (state.status === "fulfilled-undelivered") {
    return <ResendPrompt orderId={orderId} />;
  }

  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      <Field label="Carrier" name="carrier" required />
      <Field label="Tracking number" name="trackingNumber" required />
      {state.status === "error" && <p role="alert">{state.error}</p>}
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving" : "Mark shipped"}
      </Button>
    </form>
  );
}

/**
 * Shown when the parcel shipped but the email did not.
 *
 * The fulfilment is not in question here -- it is already committed. Only
 * whether the customer was told, which is why the only action offered is to
 * send it again rather than anything that would revisit the shipment.
 */
function ResendPrompt({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState<FulfillState, FormData>(
    resendShippingAction,
    { status: "idle" },
  );

  if (state.status === "fulfilled") {
    return <p role="status">Shipping email sent.</p>;
  }

  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      <p role="alert">
        Marked as shipped, but the shipping email was rejected. The order is
        correct — only the notification failed.
      </p>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Sending" : "Resend shipping email"}
      </Button>
    </form>
  );
}
