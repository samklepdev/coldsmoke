"use client";

import { useActionState } from "react";
import { refundAction, type RefundState } from "./actions";
import { Button } from "@/components/ui/Button";
import { formatCents } from "@/lib/money";

export function RefundButton({
  orderId,
  amountCents,
}: {
  orderId: string;
  amountCents: number;
}) {
  const [state, action, pending] = useActionState<RefundState, FormData>(
    refundAction,
    { status: "idle" },
  );

  if (state.status === "submitted") {
    return (
      <p role="status">
        Refund of {formatCents(state.amountCents)} submitted. Stripe confirms
        it separately — this order will show as refunded once it does, usually
        within a minute.
      </p>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      {state.status === "error" && <p role="alert">{state.error}</p>}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Refunding" : `Refund ${formatCents(amountCents)}`}
      </Button>
    </form>
  );
}
