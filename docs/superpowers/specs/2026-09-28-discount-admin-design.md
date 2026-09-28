# Discount Code Admin — Design

**Date:** 2026-09-28
**Status:** Approved, ready for an implementation plan

## 1. Why

Discount codes are half-built. The redemption half is complete and tested: a
customer enters a code in `DiscountForm` on the cart, `lookupDiscount`
normalises it, `validateDiscount` decides whether it applies,
`src/lib/cookies.ts` carries it, checkout applies it to the quote, and
`redeemDiscount` increments the counter inside the same transaction that marks
the order paid — guarded so a race cannot exceed the cap.

**Nothing creates a code.** There is no writer to `discount_codes` anywhere in
`src/`: only a read and an increment. The seed does not create any. So a
promotion can be redeemed but not made, except by hand-writing SQL — and
production Postgres has no public endpoint, so that means `railway ssh` into a
live database to run an `INSERT` by hand.

That is the whole feature: give the existing redemption path a way to be fed.

## 2. Scope

### In scope

- Creating a discount code
- Deactivating one
- Listing codes with a status that says whether each is actually usable

### Out of scope

- **Editing an existing code.** Decided deliberately — see §3.
- Deleting a code. `orders.discount_code_id` references it, so a delete would
  orphan the record of what a customer was actually charged.
- Per-customer redemption limits, product-specific discounts, bulk generation,
  automatic promotions. Each is a real feature; none is needed to stop writing
  SQL by hand.

## 3. Decisions

**Create and deactivate only; no editing.** A code is a promise made to
customers. Changing 15% to 10% after people have it in their inbox rewrites
what they were told, and because `orders.discount_code_id` points at the row
forever, historical orders would silently start describing terms nobody was
offered. Nothing in the data distinguishes "created a minute ago by mistake"
from "in ten thousand inboxes", so the safe rule is the simple one: make a new
code, switch the old one off.

**Every field the schema models is exposed, and an end date is required.** The
column is nullable and stays nullable — existing rows and the redemption path
are untouched — but the creation form refuses a code with no expiry. A promo
with no end date and no cap is unbounded liability whose only stopping
mechanism is somebody noticing. The application is deliberately stricter than
the schema here.

**Status is derived, never stored.** A code with `active = true` can still be
unusable: not started, expired, or exhausted. The admin list computes its label
from the same checks, in the same order, that decide whether a customer's entry
is accepted, so the list cannot disagree with what a customer experiences at the
cart. (This project has already been bitten by a second stored copy of a derived
fact; `awaitsStockDecision` in the restock work is the counter-example that got
it right.)

## 4. Data model

**No migration.** `discount_codes` already has `code`, `type`
(`percent`/`fixed`), `value`, `min_subtotal_cents`, `max_redemptions`,
`times_redeemed`, `starts_at`, `ends_at` and `active`, plus a unique index on
`code` and a `CHECK (code = lower(code))`.

## 5. Interface

New module `src/lib/discounts/admin.ts`:

```ts
createDiscountCode(input: {
  code: string;
  type: "percent" | "fixed";
  value: number;              // 1-100 for percent, cents for fixed
  minSubtotalCents: number;
  maxRedemptions: number | null;
  startsAt: Date | null;
  endsAt: Date;               // required by this application, nullable in schema
}): Promise<DiscountCode>

deactivateDiscountCode(id: string): Promise<void>
```

New function in `src/lib/discounts/validate.ts`, beside `validateDiscount` so
the two cannot drift:

```ts
discountStatus(code: DiscountCode): "live" | "scheduled" | "expired" | "exhausted" | "off"
```

| Status | Condition |
|---|---|
| `off` | `active = false` |
| `scheduled` | `starts_at` is in the future |
| `expired` | `ends_at` is in the past |
| `exhausted` | `max_redemptions` is set and `times_redeemed >= max_redemptions` |
| `live` | none of the above |

**`below_minimum` is deliberately not a status.** `validateDiscount` returns it,
but it describes a particular cart, not the code — a code requiring $50 is not
broken, it is waiting for a big enough basket. Including it would make the
admin list depend on a subtotal it does not have.

### Rules the application enforces

- **Codes are lowercased before insert.** There is already a
  `CHECK (code = lower(code))` constraint, so a mixed-case submission would
  otherwise surface as an opaque database error instead of working. This
  mirrors `lookupDiscount`, which normalises on read.
- **A duplicate code is caught from the unique-index violation**, not from a
  pre-read. A read-then-insert can lose the race; the constraint cannot. The
  caller turns it into a friendly message.
- **`percent` values are bounded 1-100.** A 0% code is a no-op that looks like
  a working promo, and above 100 is a refund with extra steps.

## 6. Flow and UI

A new route at `/admin/discounts`, added to the admin nav beside Orders.
`/admin` continues to redirect to `/admin/orders`.

**The list** shows, per code: the code, its derived status, the terms as a
customer sees them (`15% off`, `$10 off`, plus the minimum if set), redemptions
as `3 / 100` or `3 / ∞`, and the window. Codes that are `live` or `scheduled`
get a Deactivate button. Sorted newest first — the code you just made is the one
you are looking for.

**Create** is a form on the same page rather than a separate route: six fields
and no editing does not justify a round trip to `/new` and back.

The value input's label follows the selected type — percent shows `%`, fixed
shows a money amount. One field that silently means either 15% or 15¢ is a
mis-set promotion waiting to happen.

Forms follow `FulfillForm.tsx`; actions follow `refundAction` in
`src/app/(admin)/admin/orders/[id]/actions.ts`, including `requireAdminUser()`
as the first statement and `revalidatePath` after a successful write.

## 7. What this does not fix

Nothing reports on discount performance — how much revenue a code moved, or
what it cost. `orders.discount_code_id` and `discount_cents` hold the raw
material, but no view aggregates it. Out of scope here; worth its own feature
once codes exist to measure.

## 8. Testing

Real Postgres, no mocking of the unit under test, following the existing suites.

`createDiscountCode`:

- persists every field as given
- lowercases the code before insert
- rejects a missing end date
- rejects a `percent` value outside 1-100
- a duplicate code returns the friendly error rather than a raw constraint
  violation — and the row count is unchanged

`deactivateDiscountCode`:

- flips `active` to false
- leaves `times_redeemed`, the window and the terms untouched. A "deactivate"
  that quietly rewrote terms would corrupt what past orders reference.

`discountStatus`:

- one case per label
- specifically: a code with `active = true` whose `ends_at` has passed reports
  `expired`, not `live`. That is the case the whole derivation exists for.

The server actions:

- **require an admin, asserted explicitly.** The session module is mocked
  wholesale in this suite, so without an explicit assertion, deleting
  `requireAdminUser()` from an action leaves every other test green. This is
  the exact gap the payment-restock final review caught, and it is cheaper to
  write the assertion now than to rediscover it.

End to end, tying the two halves together:

- create a code through the admin function, redeem it through the existing
  customer path, assert `times_redeemed` moved. This is the seam where a
  created code could satisfy the form and still be unusable at the cart, and
  nothing else would notice.

## 9. Success criteria

- An admin can create a working discount code without touching SQL.
- A created code is redeemable by a customer immediately, and the redemption
  increments its counter.
- The list tells the truth about whether each code is usable right now, and
  agrees with what a customer sees at the cart.
- Deactivating a code stops new redemptions and changes nothing else.
- No code can be created without an expiry.
