"use client";

import { useActionState } from "react";
import { applyDiscountAction, type DiscountFormState } from "../actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./page.module.css";

export function DiscountForm({ applied }: { applied: string | null }) {
  const [state, action, pending] = useActionState<DiscountFormState, FormData>(
    applyDiscountAction,
    { applied: applied ?? undefined },
  );

  return (
    <form action={action} className={styles.discountForm}>
      <Field
        label="Discount code"
        name="code"
        defaultValue={state.applied ?? ""}
        error={state.error}
        autoComplete="off"
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Checking" : "Apply"}
      </Button>
    </form>
  );
}
