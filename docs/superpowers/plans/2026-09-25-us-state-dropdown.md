# US State Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace both free-text state inputs with a `<select>` of the 50 states and DC, and make that same list the server-side allowlist.

**Architecture:** One data module (`lib/addresses/states.ts`) is imported by both a new `StateSelect` control and both server actions' zod schemas, so the dropdown and the validator cannot disagree about which states exist. The submitted value stays the two-letter code, so nothing downstream of the form changes.

**Tech Stack:** Next.js 16.3.5 (App Router, Server Actions), React 19.2, zod 4.6.5, vitest 5 (node environment), Playwright, CSS Modules.

**Spec:** `docs/superpowers/specs/2026-09-25-us-state-dropdown-design.md`

## Global Constraints

- **Coverage is 50 states + DC = 51 entries.** No territories (PR, VI, GU, AS, MP), no military codes (AA, AE, AP).
- **Options display the full name and submit the two-letter code.** The submitted value must stay byte-identical to what the text input produced, or stored addresses and the Stripe Tax payload change.
- **The visible label is exactly `State`.** `e2e/checkout.spec.ts` finds the control by accessible name.
- **The new validation message is exactly `Choose a state.`** (replacing `Use a two-letter state code.`)
- **`src/lib/addresses/states.ts` must not import zod and must not import `@/lib/addresses`.** A Client Component imports it; `@/lib/addresses` reaches the Postgres client, and zod is currently absent from the client bundle. Import the list by full path — `@/lib/addresses/states` — never from the package index.
- **`src/test/plan-drift.test.ts` compares every `Create` block in a registered plan byte for byte against the shipped file.** This plan is registered in Task 5. From that point on, if you change one of these files you must update this plan's code block in the same commit.
- Verification commands: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run test:e2e`.
- The DB-backed tests need Postgres: `npm run db:test:up` first (`npm run db:test:down` when finished).

## Deviations from the spec (deliberate, already reasoned)

1. **No `isStateCode` guard.** The spec's §3 sketch exported one, but `z.enum(US_STATE_CODES)` does the only validation there is, leaving the guard with no caller. YAGNI — it is not written.
2. **No `Select.module.css`.** The spec proposed a stylesheet that `composes` from `Field.module.css`. `Select.tsx` imports `Field.module.css` directly instead, which achieves the same stated goal — one border definition that cannot drift — with one fewer file and no dependence on stylesheet ordering between two equal-specificity classes.

Everything else follows the spec as approved.

---

### Task 1: The state list

**Files:**
- Create: `src/lib/addresses/states.ts`
- Test: `src/lib/addresses/states.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `US_STATES: readonly { code: string; name: string }[]` (51 entries, sorted by name), `type StateCode`, `US_STATE_CODES: readonly StateCode[]`. Tasks 2, 3 and 4 all import from `@/lib/addresses/states`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/addresses/states.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { US_STATES, US_STATE_CODES } from "./states";

const codes: readonly string[] = US_STATE_CODES;

describe("US_STATES", () => {
  it("lists the 50 states and DC", () => {
    expect(US_STATES).toHaveLength(51);
    expect(codes).toContain("DC");
  });

  it("omits territories and military codes", () => {
    // Deliberate: the store ships ground within the US only, and offering a
    // destination it cannot fulfil is worse than omitting it. If a shipping
    // decision ever adds these, this is where that choice gets noticed.
    for (const code of ["PR", "VI", "GU", "AS", "MP", "AA", "AE", "AP"]) {
      expect(codes).not.toContain(code);
    }
  });

  it("has no duplicate code and no duplicate name", () => {
    expect(new Set(US_STATES.map((s) => s.code)).size).toBe(US_STATES.length);
    expect(new Set(US_STATES.map((s) => s.name)).size).toBe(US_STATES.length);
  });

  it("is sorted by name, so the dropdown reads alphabetically", () => {
    const names = US_STATES.map((s) => s.name);
    expect(names).toEqual([...names].sort());
  });

  it("uses two uppercase letters for every code", () => {
    for (const { code } of US_STATES) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it("exposes one code per state, in the same order", () => {
    expect(US_STATE_CODES).toEqual(US_STATES.map((s) => s.code));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/addresses/states.test.ts`
Expected: FAIL — `Failed to resolve import "./states"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/addresses/states.ts`:

```ts
/**
 * The states this store ships to, and the only values its address forms accept.
 *
 * One list doing two jobs: it populates the dropdown *and* it is the
 * server-side allowlist. Before this module the check was `/^[A-Za-z]{2}$/`,
 * which accepts "XX" -- not a state, but still handed to Stripe Tax as if it
 * were one, where it decides what tax to charge. A list used only by the UI
 * would leave that open, so both actions import US_STATE_CODES from here
 * rather than restating what a state is.
 *
 * Free of zod and of server-only imports, for the reason `lib/business.ts` and
 * `lib/cart/limits.ts` are free of the latter: a Client Component imports this
 * file. `@/lib/addresses` reaches the Postgres client, and zod is otherwise
 * confined to "use server" modules -- importing either here would drag it into
 * the browser bundle.
 *
 * Territories (PR, VI, GU, AS, MP) and military codes (AA, AE, AP) are
 * deliberately absent: the store ships ground within the US only.
 *
 * Sorted by name, which puts "District of Columbia" between Delaware and
 * Florida -- where someone scanning the list alphabetically will look for it.
 */
export const US_STATES = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "DC", name: "District of Columbia" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
] as const;

/** A code from the list above -- not merely any two letters. */
export type StateCode = (typeof US_STATES)[number]["code"];

/**
 * `readonly` is load-bearing: it is what lets `z.enum(US_STATE_CODES)` infer
 * StateCode in the actions without a tuple cast at each call site. Verified
 * against zod 4.6.5.
 */
export const US_STATE_CODES: readonly StateCode[] = US_STATES.map((s) => s.code);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/addresses/states.test.ts`
Expected: PASS — 6 tests.

If "lists the 50 states and DC" fails on the length, count the entries rather than editing the expectation: 51 is the requirement, not an observation.

- [ ] **Step 5: Commit**

```bash
git add src/lib/addresses/states.ts src/lib/addresses/states.test.ts
git commit -m "feat: add the US state list that both forms and both validators share"
```

---

### Task 2: The Select and StateSelect controls

**Files:**
- Create: `src/components/ui/Select.tsx`
- Create: `src/components/ui/StateSelect.tsx`

**Interfaces:**
- Consumes: `US_STATES` from `@/lib/addresses/states` (Task 1).
- Produces: `<Select label name error children />` (a labelled `<select>`, all `SelectHTMLAttributes` pass through) and `<StateSelect defaultValue?: string error?: string />`. Tasks 3 and 4 render `StateSelect` only.

**No unit test in this task, and that is not an oversight.** `vitest.config.ts` sets `environment: "node"` and the project has no `@testing-library/react` or jsdom, so there is no way to render a component in the unit suite. Adding a DOM testing stack to ship one control is out of proportion. These components are verified by `tsc`, by `lint`, and behaviourally by the Playwright e2e in Task 3 — which is the codebase's existing division of labour for UI.

- [ ] **Step 1: Create the Select control**

Create `src/components/ui/Select.tsx`:

```tsx
"use client";

import { useId, type SelectHTMLAttributes } from "react";
import styles from "./Field.module.css";

type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string;
};

/**
 * The select counterpart to `Field`.
 *
 * It imports Field's stylesheet rather than owning a copy: an input and a
 * select sit side by side in the address row, and two stylesheets would drift
 * -- one border colour updated, the other forgotten. The native chevron is
 * kept, so there is nothing to style around.
 */
export function Select({ label, error, className, children, ...rest }: Props) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className={styles.wrap}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={[styles.input, error && styles.invalid, className]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      >
        {children}
      </select>
      {error && (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create the StateSelect control**

Create `src/components/ui/StateSelect.tsx`:

```tsx
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
        Select a state
      </option>
      {US_STATES.map(({ code, name }) => (
        <option key={code} value={code}>
          {name}
        </option>
      ))}
    </Select>
  );
}
```

- [ ] **Step 3: Verify both compile and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both exit 0, no output from `tsc`.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/Select.tsx src/components/ui/StateSelect.tsx
git commit -m "feat: add a Select primitive and the shared StateSelect control"
```

---

### Task 3: Checkout

**Files:**
- Modify: `src/app/(store)/checkout/actions.ts:27-33` (the `state` field of `addressSchema`)
- Modify: `src/app/(store)/checkout/CheckoutForm.tsx:109-116` (the State `Field`)
- Modify: `src/app/(store)/checkout/actions.test.ts:114-145`
- Modify: `e2e/checkout.spec.ts:55-62, 85-87, 169-171`

**Interfaces:**
- Consumes: `US_STATE_CODES` from `@/lib/addresses/states` (Task 1), `StateSelect` from `@/components/ui/StateSelect` (Task 2).
- Produces: nothing new. `startCheckoutAction`'s signature and return type are unchanged.

- [ ] **Step 1: Start the test database**

Run: `npm run db:test:up`
Expected: the container reports healthy. Skip if it is already running.

- [ ] **Step 2: Update the existing tests and add the "XX" case**

In `src/app/(store)/checkout/actions.test.ts`, replace the three tests at lines 114-145 with the block below. Two assertions change message; one test is new; the normalisation test is carried over **unchanged on purpose** — it passing untouched is the signal that the control swap did not alter stored data.

Append to `src/app/(store)/checkout/actions.test.ts`:

```ts
describe("startCheckoutAction — address validation", () => {
  it("reports a field error per invalid field without touching the cart", async () => {
    const state = await start({ email: "nope", state: "texas", postalCode: "1" });

    expect(state).toMatchObject({
      status: "error",
      error: "Check the highlighted fields.",
    });
    if (state.status !== "error") throw new Error("expected an error state");
    expect(state.fieldErrors).toEqual({
      email: "Enter a valid email address.",
      state: "Choose a state.",
      postalCode: "Enter a valid ZIP code.",
    });
    expect(await ctx.db.select().from(orders)).toHaveLength(0);
  });

  it("rejects a two-character state that is not letters", async () => {
    const state = await start({ state: "12" });

    if (state.status !== "error") throw new Error("expected an error state");
    expect(state.fieldErrors?.state).toBe("Choose a state.");
  });

  it("rejects two letters that are not a state", async () => {
    // "XX" passed the old /^[A-Za-z]{2}$/ check and went on to Stripe Tax as
    // a canonical state code. This is the hole the enum closes.
    const state = await start({ state: "XX" });

    if (state.status !== "error") throw new Error("expected an error state");
    expect(state.fieldErrors?.state).toBe("Choose a state.");
    expect(await ctx.db.select().from(orders)).toHaveLength(0);
  });

  it("normalises a lowercase state to its canonical uppercase code", async () => {
    // Stripe Tax is handed this value, so "mt" must not reach it as typed.
    const state = await start({ state: "mt" });
    expect(state.status).toBe("ready");

    const [order] = await ctx.db.select().from(orders);
    expect(order.shippingAddress.state).toBe("MT");
  });
```

Leave the rest of the `describe` block (the `line2` test onwards) exactly as it is.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run "src/app/(store)/checkout/actions.test.ts"`
Expected: FAIL — three failures, each expecting `"Choose a state."` but receiving `"Use a two-letter state code."`, and the `"XX"` test failing because the status is `"ready"` rather than `"error"`.

The `"XX"` failure is the important one: it is the defect, reproduced.

- [ ] **Step 4: Update the schema**

In `src/app/(store)/checkout/actions.ts`, add the import and replace the `state` field.

Append to `src/app/(store)/checkout/actions.ts`:

```ts
import { US_STATE_CODES } from "@/lib/addresses/states";
  // The dropdown can only submit a canonical code, so trim/uppercase is now
  // defence against a hand-written POST, not against a customer typing "mt".
  // The enum is what closes the real hole: /^[A-Za-z]{2}$/ accepted "XX" and
  // handed it to Stripe Tax, which uses it to decide what tax to charge.
  state: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
    z.enum(US_STATE_CODES, { message: "Choose a state." }),
  ),
```

The two comment lines above the old field (`// Letters only, and normalised: ...`) are replaced by the comment above, and the old `z.string().trim().regex(...).transform(...)` chain is deleted.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run "src/app/(store)/checkout/actions.test.ts"`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Swap the form control**

In `src/app/(store)/checkout/CheckoutForm.tsx`, add the import beside the existing `Field` import and replace the State `Field` (lines 109-116, including its now-pointless `maxLength={2}`).

Append to `src/app/(store)/checkout/CheckoutForm.tsx`:

```tsx
import { StateSelect } from "@/components/ui/StateSelect";
      <StateSelect error={fieldErrors.state} />
```

`Field` is still imported and used by the other six fields — do not remove that import.

- [ ] **Step 7: Fix the e2e address helper**

`ADDRESS` is looped over with `.fill()` at two call sites, and Playwright's `fill()` throws on a `<select>`. Pull the loop into a helper so State is handled once rather than twice.

In `e2e/checkout.spec.ts`, remove the `State: "MT",` line from `ADDRESS` and add the helper after it.

Append to `e2e/checkout.spec.ts`:

```ts
/**
 * State is a <select>, and Playwright's fill() throws on one, so it cannot
 * ride along in the ADDRESS loop with the text fields.
 */
async function fillAddress(page: import("@playwright/test").Page) {
  for (const [label, value] of Object.entries(ADDRESS)) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByLabel("State", { exact: true }).selectOption("MT");
}
```

Then replace **both** three-line `for (const [label, value] of Object.entries(ADDRESS)) { ... }` loops — the one in "a guest can fill a cart and reach the checkout form" and the one in "a guest can buy a bottle" — with:

```ts
  await fillAddress(page);
```

- [ ] **Step 8: Run the checkout e2e**

Run: `npm run test:e2e -- checkout.spec.ts`
Expected: PASS. "a guest can buy a bottle" may report as skipped — it self-skips unless a `stripe listen` is forwarding webhooks, which is expected and not a failure.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(store)/checkout/actions.ts" "src/app/(store)/checkout/CheckoutForm.tsx" "src/app/(store)/checkout/actions.test.ts" e2e/checkout.spec.ts
git commit -m "feat: pick a state from a dropdown at checkout

The validator now comes from the same list as the options, so 'XX' --
which the old two-letter regex accepted and passed to Stripe Tax -- is
rejected."
```

---

### Task 4: Account addresses

**Files:**
- Modify: `src/app/(store)/account/addresses/actions.ts:22-26` (the `state` field)
- Modify: `src/app/(store)/account/addresses/AddressForm.tsx:66-73` (the State `Field`)
- Create: `src/app/(store)/account/addresses/actions.test.ts`

**Interfaces:**
- Consumes: `US_STATE_CODES` from `@/lib/addresses/states` (Task 1), `StateSelect` from `@/components/ui/StateSelect` (Task 2).
- Produces: nothing new. `saveAddressAction`'s signature and `AddressState` are unchanged.

`saveAddressAction` has no test file today, so without this task the address half of the change ships unverified. The new file is scoped to the state rule only; broadening it into full coverage of the action is separate work.

- [ ] **Step 1: Write the failing test**

Create `src/app/(store)/account/addresses/actions.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { user, addresses } from "@/lib/db/schema";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// The action's ownership model is "the id comes from the session, never the
// form". These tests are about the state rule, so the session is a fixture.
vi.mock("@/lib/auth/session", () => ({
  requireSessionUser: async () => ({ id: "user_1" }),
}));

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { saveAddressAction } = await import("./actions");

const VALID = {
  label: "Home",
  name: "Test Buyer",
  line1: "1 Powder Lane",
  line2: "",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
};

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({ ...VALID, ...overrides })) {
    data.append(key, value);
  }
  return data;
}

async function save(overrides?: Record<string, string>) {
  return saveAddressAction({ status: "idle" }, form(overrides));
}

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  await ctx.db.insert(user).values({
    id: "user_1",
    name: "Buyer One",
    email: "one@example.com",
    emailVerified: true,
  });
});

describe("saveAddressAction — state validation", () => {
  it("rejects two letters that are not a state", async () => {
    // "XX" passed the old /^[A-Za-z]{2}$/ check and was stored as if real.
    const state = await save({ state: "XX" });

    if (state.status !== "error") throw new Error("expected an error state");
    expect(state.fieldErrors?.state).toBe("Choose a state.");
    expect(await ctx.db.select().from(addresses)).toHaveLength(0);
  });

  it("stores a lowercase code in its canonical uppercase form", async () => {
    const state = await save({ state: "mt" });
    expect(state.status).toBe("saved");

    const [saved] = await ctx.db.select().from(addresses);
    expect(saved.state).toBe("MT");
  });

  it("echoes the other fields back so one bad field costs one correction", async () => {
    const state = await save({ state: "XX" });

    if (state.status !== "error") throw new Error("expected an error state");
    expect(state.values?.line1).toBe("1 Powder Lane");
    expect(state.values?.city).toBe("Bozeman");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "src/app/(store)/account/addresses/actions.test.ts"`
Expected: FAIL — "rejects two letters that are not a state" throws `expected an error state`, because `"XX"` is currently accepted and saved. The "echoes the other fields back" test fails the same way.

- [ ] **Step 3: Update the schema**

In `src/app/(store)/account/addresses/actions.ts`, add the import and replace the `state` field.

Append to `src/app/(store)/account/addresses/actions.ts`:

```ts
import { US_STATE_CODES } from "@/lib/addresses/states";
  // Same list the dropdown renders from, so the form and the validator cannot
  // disagree about what a state is. See lib/addresses/states.ts.
  state: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
    z.enum(US_STATE_CODES, { message: "Choose a state." }),
  ),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "src/app/(store)/account/addresses/actions.test.ts"`
Expected: PASS — 3 tests.

- [ ] **Step 5: Swap the form control**

In `src/app/(store)/account/addresses/AddressForm.tsx`, add the import and replace the State `Field` inside the `<div className={styles.row}>`, keeping the ZIP `Field` beside it untouched.

Append to `src/app/(store)/account/addresses/AddressForm.tsx`:

```tsx
import { StateSelect } from "@/components/ui/StateSelect";
        <StateSelect
          defaultValue={valueFor("state")}
          error={errorFor("state")}
        />
```

`valueFor("state")` keeps the re-seeding behaviour the file's comment describes: on a rejected submit the dropdown reopens on the state the customer chose, not blank.

- [ ] **Step 6: Verify the whole unit suite and the types**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(store)/account/addresses/actions.ts" "src/app/(store)/account/addresses/AddressForm.tsx" "src/app/(store)/account/addresses/actions.test.ts"
git commit -m "feat: pick a state from a dropdown when saving an address

Also adds the first test file for saveAddressAction, which had none."
```

---

### Task 5: Register the plan and verify the whole change

**Files:**
- Modify: `src/test/plan-drift.test.ts:23-30` (the `PLANS` array)

**Interfaces:**
- Consumes: every file created in Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Register this plan with the drift guard**

Add one entry to the `PLANS` array in `src/test/plan-drift.test.ts`, after the existing entries.

Append to `src/test/plan-drift.test.ts`:

```ts
  "docs/superpowers/plans/2026-09-25-us-state-dropdown.md",
```

- [ ] **Step 2: Run the drift guard**

Run: `npx vitest run src/test/plan-drift.test.ts`
Expected: PASS.

If a `matches the plan byte for byte` case fails, the shipped file and this plan's `Create` block have diverged. **Update this plan's code block to match the shipped file** — that is what the guard is for. Do not weaken the test, and do not edit the source back unless the source is the thing that is wrong.

This step will also flag `CheckoutForm.tsx` or `AddressForm.tsx` drift against the *older* plans (`2026-09-19-coldsmoke-storefront-checkout.md`, `2026-09-20-customer-accounts.md`), since Tasks 3 and 4 edited files those plans describe. Those are `Append`-style subsequence checks, so they only fail if a line they assert was removed. If one does fail, update that plan's block to the shipped code in this same commit.

- [ ] **Step 3: Run everything**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run test:e2e`
Expected: all green.

- [ ] **Step 4: Confirm the success criteria by hand**

Start the app (`npm run dev`) and check, at `/checkout` with a bottle in the cart:

- The State control is a dropdown reading "Select a state", then Alabama through Wyoming with District of Columbia between Delaware and Florida.
- Submitting without touching it is refused by the browser, not the server.
- Choosing Montana and submitting reaches the payment step.
- At `/account/addresses`, saving with a deliberately bad *ZIP* re-renders with Montana still selected.

- [ ] **Step 5: Commit**

```bash
git add src/test/plan-drift.test.ts docs/superpowers/plans/2026-09-25-us-state-dropdown.md
git commit -m "test: guard the state dropdown plan against drift"
```

- [ ] **Step 6: Stop the test database**

Run: `npm run db:test:down`

---

## Success criteria

- No form on the site accepts a typed state code.
- An invalid state cannot reach Stripe Tax from the application.
- A stored `MT` from before the change reads and renders identically after it.
- `npm test`, `npx tsc --noEmit`, `npm run lint` and `npm run test:e2e` are green, with the plans in sync.
