"use client";

import { useActionState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signInAction, type SignInState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./page.module.css";

export function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(
    signInAction,
    { status: "idle" },
  );
  const router = useRouter();
  const params = useSearchParams();

  /**
   * Redirect after the action reports success rather than from inside the
   * action. `next` is attacker-controllable, so it is only ever used as a
   * same-site path: a value like "https://elsewhere.example" would otherwise
   * turn our sign-in form into an open redirect.
   */
  useEffect(() => {
    if (state.status !== "ok") return;
    const next = params.get("next");
    const safe =
      next && next.startsWith("/") && !next.startsWith("//") ? next : "/account/orders";
    router.push(safe);
  }, [state.status, params, router]);

  return (
    <form action={action} className={styles.form}>
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />

      {state.status === "error" && (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      )}

      {state.status === "unverified" && (
        <p role="alert" className={styles.error}>
          Confirm your email address first.{" "}
          <Link href={`/verify-email?email=${encodeURIComponent(state.email)}`}>
            Send the link again
          </Link>
          .
        </p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Signing in" : "Sign in"}
      </Button>

      <p>
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
      <p>
        New here? <Link href="/sign-up">Create an account</Link>.
      </p>
    </form>
  );
}
