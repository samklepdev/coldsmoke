# Refund Restock — Design

**Date:** 2026-09-27
**Status:** Approved, ready for an implementation plan

## 1. Why

Refunding an order returns the customer's money and nothing else. `recordRefund`
(`src/lib/orders/refund.ts`) updates `refunded_cents` and the order status, and
touches inventory not at all.

`releaseStock` looks like it covers this, but it does not: it unwinds
*reservations* for pending orders that expired. By the time an order is paid,
`commitStock` has already decremented `on_hand` and consumed the reservation.
Nothing adds those units back, ever.

So every refund permanently destroys stock on paper. The shop will eventually
refuse to sell bottles that are sitting on the shelf, and the drift is silent —
there is no log line, no flag, and no page where the number looks wrong.

## 2. Scope

### In scope

- Returning units to `on_hand` when goods come back from a refunded order
- Letting the admin decide, per order, whether a refund restocks and by how much
- Making a refund that has had no stock decision visible in the admin panel

### Out of scope

- General inventory adjustment (receiving new stock, correcting counts). Related
  and worth building, but it is a different feature with a different entry point.
- Restocking triggered by anything other than a refund.
- Reconciling refunds whose webhook never arrived — see §7.
- An inventory movement history. See Approach C in §3.

## 3. Decisions

**The admin decides at refund time, per line.** Fragrance makes the automatic
rules wrong in both directions: an unshipped order is fully resalable, while an
opened bottle that came back is not, and only a human knows which. A partial
refund — one bottle of two — has to be expressible, so the decision is per order
line and not per order.

**A refund with no decision does not restock, and says so.** Dashboard-issued
refunds arrive through the `charge.refunded` webhook with nobody to ask.
Defaulting to restocking would invent stock in exactly the case where the system
knows least. Defaulting to silence would repeat the failure that motivated this
work — a decision quietly disappearing. So: do not restock, and surface it.

**Rejected approaches:**

- *Extend the `inventory_state` machine with a `restocked` state.* Smallest diff
  and consistent with `commitStock`/`releaseStock`, but that machine is
  order-level and all-or-nothing. It cannot express "1 of 2 came back", and
  overloading it would break the single-transition claim that makes commit and
  release idempotent.
- *A new `stock_returns` ledger table.* Unnecessary — see below, a ledger
  already exists.

**Amended 2026-09-27, before the plan was written:** `inventory_adjustments`
(`product_id`, `delta`, `reason`, `admin_user_id`, `created_at`) is already
migrated and **entirely unused** — no writers, no readers, no rows. It was
evidently created for exactly this kind of movement and never wired up. A
restock therefore also writes an adjustment row in the same transaction, making
this feature the ledger's first writer.

To be clear about the division of labour: `restocked_quantity` remains the
**guard** — it carries the per-line bound that makes over-restocking impossible.
The ledger is **history**, and is never read to decide whether a restock is
allowed. Summing ledger rows to enforce the bound would be slower and far easier
to get wrong under concurrency.
- *Derive units from the refunded amount.* Shipping, tax and discounts mean the
  amount does not divide cleanly into units, and a wrong guess corrupts stock
  silently.

## 4. Data model

Two additions:

| Table | Column | Type | Notes |
|---|---|---|---|
| `order_items` | `restocked_quantity` | `integer not null default 0` | Never exceeds `quantity` |
| `orders` | `stock_decision_at` | `timestamptz null` | Set for *either* decision — restock or write-off |

The "awaiting a stock decision" state is **derived, never stored**: an order with
`refunded_cents > 0` and `stock_decision_at IS NULL`. There is no flag to keep in
sync and nothing that can drift from the underlying facts.

`stock_decision_at` deliberately records *that* a decision was made, not which
one. "Restocked" versus "written off" is already visible in the per-line
`restocked_quantity` values; a second column encoding the same thing could
contradict them.

## 5. Interface

New function in `src/lib/inventory/index.ts`, beside its siblings:

```ts
restockOrderItems(
  tx: Tx,
  orderId: string,
  lines: { orderItemId: string; quantity: number }[],
  adminUserId: string,
): Promise<void>
```

For each line it adds `quantity` to that product's `inventory.on_hand`, adds it to
the line's `restocked_quantity`, and inserts an `inventory_adjustments` row
(`delta` = +quantity, `reason` = `"refund_restock"`, `admin_user_id` = the acting
admin). All three happen in the caller's transaction, so the ledger cannot record
a movement that did not occur.

**The bound is the idempotency guarantee.** It is enforced in the write, not by
reading first:

```sql
UPDATE order_items SET restocked_quantity = restocked_quantity + $n
 WHERE id = $id AND restocked_quantity + $n <= quantity
 RETURNING *
```

No row returned means the whole transaction is rejected. This is the same
conditional-update shape as `markOrderPaid`, and it makes a double-submitted form
or two admins clicking at once safe without a lock. Unlike a state-machine claim
it still permits a *later* second return of the remaining unit.

`reserved` is never touched. A committed order has already consumed its
reservation; returning units there would make them look spoken-for by an order
that no longer exists.

### Refusals

The function rejects rather than guesses:

- **Order whose `inventory_state` is not `committed`.** Those units were never
  deducted, so returning them would invent stock.
- **Order with `refunded_cents = 0`.** This feature is about refunds; general
  stock adjustment is out of scope (§2).
- **Every line zero.** Rejected with a message pointing at the write-off action.
  Silently treating it as a write-off would make a mis-click permanent.

  Note this does not conflict with the write-off flow in §6: writing off is a
  separate action that stamps `stock_decision_at` directly and never calls
  `restockOrderItems`. Zero units reaching this function means a submitted
  restock form that restocks nothing, which is a mistake rather than an
  instruction.

## 6. Flow and UI

The refund action is unchanged — money only. The stock decision is a separate
step on the order page, so an admin refund and a dashboard refund converge on one
piece of UI and one code path, and a stock question can never block or complicate
a money movement.

On `/admin/orders/[id]`, a **Stock** panel appears when `refunded_cents > 0` and
`stock_decision_at` is null:

- One row per order line: name, ordered quantity, already restocked, and a number
  input pre-filled with the remaining quantity.
- **Return to stock** applies the quantities and stamps `stock_decision_at`.
- **Write off** stamps `stock_decision_at` with nothing restocked.

After a decision the panel collapses to a summary ("2 returned to stock on
27 Sep"). If units remain un-restocked, a *Restock more* control re-opens the
form — the second-bottle-a-week-later case, which the per-line bound already
supports.

The admin orders list marks orders awaiting a decision, so they are findable
without opening each one.

The form follows `FulfillForm.tsx`; the action follows `refundAction` in
`src/app/(admin)/admin/orders/[id]/actions.ts`, including `requireAdminUser()`
and `revalidatePath`.

## 7. What this does not fix

`refunded_cents` is set by the `charge.refunded` webhook, not by the refund
action — Stripe confirms asynchronously, which is why the existing Refund button
says "Stripe confirms." **If that webhook never arrives, the stock decision never
appears**, in the same way an order once stayed `pending` forever.

This is a known limitation, not an oversight. `reconcilePendingOrder` covers only
`payment_intent.succeeded`; extending reconciliation to refunds is its own piece
of work and is not attempted here. The failure is at least bounded: the units
stay deducted, which is the conservative direction — the store under-sells rather
than overselling something it does not have.

## 8. Testing

Real Postgres, no mocking of the unit under test, following the existing suites.

`restockOrderItems`:

- increments `on_hand` and `restocked_quantity` by the requested amount
- rejects a quantity that would exceed what was ordered
- running the same restock twice returns the units once
- leaves `reserved` untouched
- refuses an order whose `inventory_state` is not `committed`
- refuses an order with no refund recorded
- writes one `inventory_adjustments` row per restocked line, with the acting
  admin's id, and writes none at all when the restock is rejected

The admin action, mirroring `refundAction.test.ts`:

- requires an admin
- rejects a non-refunded order
- write-off stamps `stock_decision_at` with zero units restocked
- a partial restock leaves the order eligible for *Restock more*

The derived flag:

- appears for a refunded order with no decision, and is gone once decided

**The bound will be mutation-tested.** Removing
`restocked_quantity + $n <= quantity` from the `UPDATE` must make a test fail. A
test that passes either way is not protecting the invariant — this branch already
shipped one such test, which looked like evidence and was not.

No new e2e. `admin.spec.ts` is local-only by construction (it writes to the
database directly as a stand-in for admin setup), and this is fully covered at
the action layer.

## 9. Success criteria

- Refunding an order and choosing *Return to stock* raises `on_hand` by exactly
  the units chosen.
- Choosing *Write off* changes no stock and clears the pending flag.
- A refund issued from the Stripe dashboard shows as awaiting a decision and
  changes no stock until the admin acts.
- A restock cannot return more units than were ordered, under any sequence of
  submissions.
- A partially restocked order can be restocked again later, up to the remainder.
