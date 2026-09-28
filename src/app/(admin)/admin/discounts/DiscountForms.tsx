"use client";

import { useActionState, useState } from "react";
import {
  createDiscountAction,
  deactivateDiscountAction,
  type DiscountAdminState,
} from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./discounts.module.css";

/**
 * Create a code.
 *
 * The value field's label follows the selected type. One input that silently
 * means either 15% or 15 cents is a mis-set promotion waiting to happen.
 */
export function CreateDiscountForm() {
  const [type, setType] = useState<"percent" | "fixed">("percent");
  const [state, action, pending] = useActionState<DiscountAdminState, FormData>(
    createDiscountAction,
    { status: "idle" },
  );

  return (
    <form action={action} className={styles.create}>
      <Field label="Code" name="code" required autoComplete="off" />

      <label className={styles.typeLabel}>
        Type
        <select
          name="type"
          value={type}
          onChange={(event) =>
            setType(event.target.value === "fixed" ? "fixed" : "percent")
          }
        >
          <option value="percent">Percent off</option>
          <option value="fixed">Amount off</option>
        </select>
      </label>

      <Field
        label={type === "percent" ? "Percent off" : "Amount off ($)"}
        name="value"
        type="number"
        min={type === "percent" ? 1 : 0.01}
        max={type === "percent" ? 100 : undefined}
        step={type === "percent" ? 1 : 0.01}
        required
      />

      <Field
        label="Minimum order ($)"
        name="minSubtotal"
        type="number"
        min={0}
        step={0.01}
        defaultValue="0"
      />

      <Field
        label="Max redemptions (blank for unlimited)"
        name="maxRedemptions"
        type="number"
        min={1}
        step={1}
      />

      <Field label="Starts (optional)" name="startsAt" type="date" />
      <Field label="Ends" name="endsAt" type="date" required />

      {state.status === "error" && <p role="alert">{state.error}</p>}
      {state.status === "created" && (
        <p role="status">Created {state.code}.</p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating" : "Create code"}
      </Button>
    </form>
  );
}

export function DeactivateButton({ id, code }: { id: string; code: string }) {
  const [state, action, pending] = useActionState<DiscountAdminState, FormData>(
    deactivateDiscountAction,
    { status: "idle" },
  );

  if (state.status === "deactivated") {
    return <span role="status">Off</span>;
  }

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      {state.status === "error" && <span role="alert">{state.error}</span>}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Saving" : `Deactivate ${code}`}
      </Button>
    </form>
  );
}
