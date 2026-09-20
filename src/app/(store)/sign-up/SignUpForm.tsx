"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUpAction, type SignUpState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./page.module.css";

export function SignUpForm() {
  const [state, action, pending] = useActionState<SignUpState, FormData>(
    signUpAction,
    { status: "idle" },
  );

  if (state.status === "sent") {
    return (
      <p role="status">
        Check {state.email} for a link to confirm your address. You will not be
        able to sign in until you do.
      </p>
    );
  }

  return (
    <form action={action} className={styles.form}>
      <Field
        label="Your name"
        name="name"
        autoComplete="name"
        required
        error={state.status === "error" ? state.fieldErrors?.name : undefined}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={state.status === "error" ? state.fieldErrors?.email : undefined}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        error={state.status === "error" ? state.fieldErrors?.password : undefined}
      />

      {state.status === "error" && !state.fieldErrors && (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating" : "Create account"}
      </Button>

      <p>
        Already have an account? <Link href="/sign-in">Sign in</Link>.
      </p>
    </form>
  );
}
