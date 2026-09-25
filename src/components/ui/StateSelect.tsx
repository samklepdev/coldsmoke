"use client";

import { US_STATES } from "@/lib/addresses/states";
import { Select } from "./Select";

/**
 * The single definition of the state control, so checkout and the account
 * address form cannot end up offering different lists or different labels.
 *
 * The label is exactly "State" because `e2e/checkout.spec.ts` finds the
 * control by accessible name.
 *
 * Options show the full name and submit the code, so the value posted is the
 * same "MT" the text input used to post. Nothing downstream changes: not the
 * stored address, not the Stripe Tax payload.
 *
 * The empty first option is `disabled`, so it cannot be chosen back once a
 * state is picked; with `required`, an untouched form is refused by native
 * constraint validation before the action runs.
 */
export function StateSelect({
  defaultValue,
  error,
}: {
  defaultValue?: string;
  error?: string;
}) {
  return (
    <Select
      label="State"
      name="state"
      autoComplete="address-level1"
      required
      defaultValue={defaultValue || ""}
      error={error}
    >
      <option value="" disabled>
        Choose a state
      </option>
      {US_STATES.map(({ code, name }) => (
        <option key={code} value={code}>
          {name}
        </option>
      ))}
    </Select>
  );
}
