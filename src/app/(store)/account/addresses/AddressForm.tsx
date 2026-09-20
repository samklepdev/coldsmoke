"use client";

import { useActionState } from "react";
import { saveAddressAction, type AddressState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./page.module.css";

export function AddressForm() {
  const [state, action, pending] = useActionState<AddressState, FormData>(
    saveAddressAction,
    { status: "idle" },
  );

  const errorFor = (name: string) =>
    state.status === "error" ? state.fieldErrors?.[name] : undefined;

  /**
   * React resets an uncontrolled form once its action returns, so a rejected
   * submission would otherwise blank every field. Re-seeding from the values
   * the action echoed back means one bad state code costs one correction,
   * not the whole address.
   */
  const valueFor = (name: string) =>
    state.status === "error" ? (state.values?.[name] ?? "") : "";

  return (
    <form action={action} className={styles.form}>
      <Field
        label="Label (optional)"
        name="label"
        placeholder="Home"
        defaultValue={valueFor("label")}
      />
      <Field
        label="Full name"
        name="name"
        autoComplete="name"
        required
        defaultValue={valueFor("name")}
        error={errorFor("name")}
      />
      <Field
        label="Address"
        name="line1"
        autoComplete="address-line1"
        required
        defaultValue={valueFor("line1")}
        error={errorFor("line1")}
      />
      <Field
        label="Apartment (optional)"
        name="line2"
        autoComplete="address-line2"
        defaultValue={valueFor("line2")}
      />
      <Field
        label="City"
        name="city"
        autoComplete="address-level2"
        required
        defaultValue={valueFor("city")}
        error={errorFor("city")}
      />
      <div className={styles.row}>
        <Field
          label="State"
          name="state"
          autoComplete="address-level1"
          required
          defaultValue={valueFor("state")}
          error={errorFor("state")}
        />
        <Field
          label="ZIP"
          name="postalCode"
          autoComplete="postal-code"
          required
          defaultValue={valueFor("postalCode")}
          error={errorFor("postalCode")}
        />
      </div>

      {state.status === "saved" && <p role="status">Address saved.</p>}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving" : "Save address"}
      </Button>
    </form>
  );
}
