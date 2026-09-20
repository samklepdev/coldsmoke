"use client";

import { useActionState } from "react";
import { requestResetAction, type ForgotState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

export function ForgotForm() {
  const [state, action, pending] = useActionState<ForgotState, FormData>(
    requestResetAction,
    { status: "idle" },
  );

  if (state.status === "sent") {
    return (
      <p role="status">
        If that address has an account, a reset link is on its way. It expires
        in an hour.
      </p>
    );
  }

  return (
    <form action={action}>
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Sending" : "Send a reset link"}
      </Button>
    </form>
  );
}
