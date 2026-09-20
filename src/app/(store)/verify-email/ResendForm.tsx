"use client";

import { useActionState } from "react";
import Link from "next/link";
import { resendVerificationAction, type ResendState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

export function ResendForm({ defaultEmail }: { defaultEmail?: string }) {
  const [state, action, pending] = useActionState<ResendState, FormData>(
    resendVerificationAction,
    { status: "idle" },
  );

  if (state.status === "sent") {
    return (
      <p role="status">
        If that address has an unverified account, a new link is on its way.
      </p>
    );
  }

  if (state.status === "undelivered") {
    return (
      <p role="alert">
        We tried, but we could not send the email just now — this is a problem
        on our end, not with your account. Please{" "}
        <Link href="/contact">contact us</Link> and we will confirm your
        address for you.
      </p>
    );
  }

  return (
    <form action={action}>
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        defaultValue={defaultEmail}
        required
      />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Sending" : "Send the link again"}
      </Button>
    </form>
  );
}
