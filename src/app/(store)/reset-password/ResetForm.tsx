"use client";

import { useActionState } from "react";
import Link from "next/link";
import { resetPasswordAction, type ResetState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

export function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(
    resetPasswordAction,
    { status: "idle" },
  );

  if (state.status === "ok") {
    return (
      <p role="status">
        Your password is changed. <Link href="/sign-in">Sign in</Link>.
      </p>
    );
  }

  return (
    <form action={action}>
      {/* The token rides along in the form rather than being read from the
          URL inside the action: a Server Action has no access to the page's
          query string. */}
      <input type="hidden" name="token" value={token} />
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        error={state.status === "error" ? state.fieldErrors?.password : undefined}
      />

      {state.status === "error" && !state.fieldErrors && (
        <p role="alert">{state.error}</p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving" : "Set a new password"}
      </Button>
    </form>
  );
}
