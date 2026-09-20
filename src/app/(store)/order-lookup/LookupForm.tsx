"use client";

import { useActionState } from "react";
import { lookupOrderAction, type LookupState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./page.module.css";

export function LookupForm() {
  const [state, action, pending] = useActionState<LookupState, FormData>(
    lookupOrderAction,
    {},
  );

  return (
    <form action={action} className={styles.form}>
      <Field
        label="Order number"
        name="orderNumber"
        placeholder="CS-1042"
        autoComplete="off"
        required
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />

      {state.error && (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Looking" : "Find order"}
      </Button>
    </form>
  );
}
