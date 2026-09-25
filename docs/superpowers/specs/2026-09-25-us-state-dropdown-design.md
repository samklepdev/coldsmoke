# US State Dropdown — Design

**Date:** 2026-09-25
**Status:** Approved design, pending implementation plan

Replace every free-text state input with a `<select>` listing the 50 states and DC,
and make that same list the server-side allowlist.

---

## 1. Why

Two reasons, one of them a latent defect.

**Typing a state code is a guess.** Both address forms ask for a two-letter code with
no indication of what is valid. A customer who writes "Mont" or "Texas" gets an error
after submitting, and on checkout that error arrives at the end of a paid funnel.

**The current check accepts codes that do not exist.** `/^[A-Za-z]{2}$/` passes `"XX"`,
`"ZZ"`, `"QQ"`. Those reach `createPendingOrder` and go on to Stripe Tax as a canonical
`state`, which is the field Stripe uses to decide what tax to charge. Nothing in the
codebase rejects them; the failure surfaces downstream, after money has moved.

This is worth stating precisely because it changes what the control is for. A dropdown
is a convenience. Deriving the *validator* from the same list is the fix — it makes an
invalid state unrepresentable rather than merely inconvenient to type.

---

## 2. Scope

State is entered in exactly two places. Everywhere else — `admin/orders/[id]/page.tsx`,
`account/addresses/page.tsx` — only renders a stored value and needs no change.

### In scope

| Location | Change |
|---|---|
| `src/app/(store)/checkout/CheckoutForm.tsx:109` | `Field` → `StateSelect` |
| `src/app/(store)/account/addresses/AddressForm.tsx:66` | `Field` → `StateSelect` |
| `src/app/(store)/checkout/actions.ts:29` | regex → allowlist |
| `src/app/(store)/account/addresses/actions.ts:22` | regex → allowlist |

Plus three new files (§3) and the test updates in §6.

### Out of scope

- **Territories and military codes.** PR, VI, GU, AS, MP, AA/AE/AP are omitted. The
  checkout copy already says "ground within the US only"; ground carriers price and
  route those destinations differently and APO/FPO is USPS-only. Adding them to the
  dropdown would advertise fulfilment that does not exist. Revisit alongside a real
  shipping decision, not as a side effect of this change.
- **A country selector.** The store ships to one country. A second dropdown whose only
  option is "United States" is a click that teaches nothing.
- **A searchable combobox.** A native `<select>` gets the platform picker on mobile,
  keyboard type-ahead on desktop, and `autoComplete="address-level1"` browser autofill,
  at no bundle cost. 51 options is well inside what a native select handles. A custom
  listbox would mean reimplementing all three.
- **Deduplicating the two zod schemas.** They overlap on more than `state`, but merging
  them is a separate change with its own reasoning. See §4 for why `state` specifically
  is not shared either.

---

## 3. Architecture

| Unit | Responsibility |
|---|---|
| `src/lib/addresses/states.ts` (new) | The list, the `StateCode` type, an `isStateCode` guard. Knows nothing about forms or validation libraries. |
| `src/components/ui/Select.tsx` (new) | A labelled `<select>` with error display. Knows nothing about states. |
| `src/components/ui/StateSelect.tsx` (new) | Binds the list to the control. The only thing either form imports. |

### `lib/addresses/states.ts`

```ts
export const US_STATES = [
  { code: "AL", name: "Alabama" },
  // ...
] as const;

export type StateCode = (typeof US_STATES)[number]["code"];
export const US_STATE_CODES: readonly StateCode[] = US_STATES.map((s) => s.code);
export function isStateCode(value: string): value is StateCode;
```

`readonly` is load-bearing: it is what lets `z.enum(US_STATE_CODES)` infer `StateCode`
in §4 without a tuple cast at the call site. Verified against the installed zod (4.6.5).

Sorted by name, with "District of Columbia" falling between Delaware and Florida — where
someone scanning the list alphabetically will look for it.

**Free of server-only imports, and free of zod.** `@/lib/addresses` reaches the Postgres
client, so a Client Component importing the list from the package index would drag the
driver into the browser bundle — the same constraint that produced `lib/cart/limits.ts`
and `lib/business.ts`. Excluding zod is the same rule applied one step further: zod is
currently confined to `"use server"` modules and is absent from the client bundle.
A `StateSelect` importing a module that imports zod would put it there.

### `components/ui/Select.tsx`

Mirrors `Field` exactly — `useId`, associated `<label>`, `aria-invalid`,
`aria-describedby`, and an error `<span role="alert">`. The difference is the element.

`Select.module.css` uses `composes` to take `wrap`, `label`, `input` and `error` from
`Field.module.css`, adding only what a `<select>` needs (`appearance`, room for the
chevron). One border definition, one focus treatment: an input and a select sitting
next to each other in the same row cannot drift apart visually.

### `components/ui/StateSelect.tsx`

Fixes `label="State"`, `name="state"`, `autoComplete="address-level1"` and the options.
Accepts `defaultValue` and `error` so `AddressForm` can keep re-seeding after a failed
submit. Both forms get an identical control because there is only one definition of it.

The label stays exactly `"State"` — `e2e/checkout.spec.ts` selects it by accessible
name, and renaming it would break that selector for no benefit.

### Markup

```tsx
<select name="state" required defaultValue={defaultValue ?? ""}>
  <option value="" disabled>Select a state</option>
  {US_STATES.map(({ code, name }) => (
    <option key={code} value={code}>{name}</option>
  ))}
</select>
```

Options display the full name and submit the code. **The submitted value is
byte-identical to what the text input produced** — `"MT"` — so nothing downstream
changes: not the `Address` shape, not what is written to the database, not the Stripe
Tax payload.

The empty first option is `disabled`, so it cannot be chosen back; combined with
`required`, an untouched form is refused by native constraint validation before it
reaches the action.

---

## 4. Validation

Both actions replace the regex with an enum over the shared code list:

```ts
state: z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  z.enum(US_STATE_CODES, { message: "Choose a state." }),
),
```

Verified against the installed zod (4.6.5): `" mt "` parses to `"MT"` typed as
`StateCode`, and both `"XX"` and `""` fail with `"Choose a state."`

Three consequences, stated deliberately:

**It tightens.** `"XX"` passes today and is rejected after this change. That is the
point of the change, not a side effect of it.

**The uppercase preprocess stays.** The dropdown can only submit canonical codes, so it
is now defence against a hand-written POST rather than against a customer typing `"mt"`.
It costs one line and keeps the existing normalisation test meaningful as a regression
guard.

**The message changes** from `"Use a two-letter state code."` to `"Choose a state."`
Nobody types a code anymore, so instructing them how to format one is misleading. The
message is now addressed to a forged request, and the wording still reads correctly if a
future bug ever surfaces it to a real person.

The schema is written out in both actions rather than exported from `states.ts`, because
sharing it would mean `states.ts` imports zod — and `states.ts` is imported by a Client
Component (§3). Three lines duplicated is the cheaper side of that trade. The shared part
that matters, `US_STATE_CODES`, *is* shared: the two schemas cannot disagree about which
states exist.

---

## 5. Accessibility

- The `<label>` is associated by `htmlFor`/`id` through `useId`, as `Field` already does.
- `aria-invalid` and `aria-describedby` point at the error, so the reason is announced
  rather than only shown in red.
- Native `<select>` keeps the platform picker on touch devices and type-ahead on desktop.
  Typing "mo" jumps to Montana because options are labelled by name.
- Borders reuse `--line-bright`, which clears the 3:1 non-text contrast floor on
  `--panel` — inherited via `composes`, so it cannot be forgotten.

---

## 6. Testing

### Updated

- `checkout/actions.test.ts:116` and `:131` assert `"Use a two-letter state code."`.
  Both move to `"Choose a state."`; `:131`'s `"12"` case keeps its meaning (a non-state
  string is refused) under the new rule.
- **`e2e/checkout.spec.ts:60`.** `State: "MT"` sits in the `ADDRESS` map that the test
  loops over with `.fill()`, and Playwright's `fill()` throws on a `<select>`. State
  moves out of that loop into an explicit
  `page.getByLabel("State", { exact: true }).selectOption("MT")`. This is a required
  change, not an optional tidy — the suite fails without it.

### New

- `startCheckoutAction` rejects `"XX"`: well-formed under the old regex, not a state.
  This is the behaviour the change exists to add, so it is the test that must exist.
- `US_STATES` has 51 entries with unique codes and unique names.
- **A first test file for `saveAddressAction`.** There is no
  `account/addresses/actions.test.ts` — the action is currently unit-tested nowhere, so
  the address form's half of this change would otherwise ship unverified. Scope it to
  this change only: `"XX"` rejected, `"mt"` stored as `"MT"`. Broadening it into full
  coverage of the action is a separate piece of work.

### Unchanged

`checkout/actions.test.ts:138` — `"mt"` normalises to `"MT"` and is stored as `"MT"`.
This test passing untouched is the signal that the control swap did not alter stored
data, which is the main risk in the whole change.

---

## 7. Plan drift

`src/test/plan-drift.test.ts` checks shipped code against the code blocks in every plan
listed in `PLANS`. `CheckoutForm.tsx` and `AddressForm.tsx` are covered by the storefront
and customer-accounts plans, so editing them without updating those plans fails
`npm test`. The implementation plan must either update the affected blocks or mark them
`plan-drift: partial` with a reason, in the same commit — and the new plan gets added to
`PLANS` once it lands.

---

## 8. Success criteria

- No form on the site accepts a typed state code.
- An invalid state cannot reach Stripe Tax from the application.
- A stored `MT` before the change reads and renders identically after it.
- `npm test`, `tsc`, `lint`, and the e2e suite are green, with the plans in sync.
