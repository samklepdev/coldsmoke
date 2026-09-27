# Payment Reconciliation — Design

**Date:** 2026-09-25
**Status:** Approved design, pending implementation plan

Give the app a second way to learn that a payment succeeded, so a webhook that
never arrives stops meaning a customer is charged for nothing.

---

## 1. Why

**A real payment is stranded right now.** Order 1030 was created 2026-09-25 at
18:41 and is still `pending`. Its PaymentIntent `pi_3UJe42C4O5W0d4Lo3Vq1CSNv`
reports `status: succeeded`, `amount_received: 5100`. Stripe captured $51.00 and
the application does not know.

The consequences are not cosmetic. For that order: no confirmation email, stock
never committed, nothing for an admin to fulfil, and the customer's cart still
holds the two items they just bought — which is the symptom that surfaced the
problem, reported as "the cart still shows items after paying".

**The cause is that the webhook is the only source of truth.**
`src/app/api/stripe/webhook/route.ts:111` holds the only `clearCart` call in the
codebase, and it runs only inside `payment_intent.succeeded` handling. Nothing
else, anywhere, marks an order paid. Locally the event was never delivered
because no `stripe listen` was forwarding. In production the same shape appears
whenever delivery fails — endpoint down mid-deploy, signature mismatch, cold
start past Stripe's timeout.

**And the code documents a recovery it does not have.**
`webhook/route.ts:99` reads: "a stale cart is corrected on the customer's next
visit." Nothing corrects it. That sentence describes this design, written before
it existed.

Stripe retries a failed delivery for about three days, so production is more
forgiving than local dev. It is not a guarantee, and it does nothing for an
endpoint that returns 200 while failing, or for a signing-secret mismatch that
400s every attempt.

---

## 2. Scope

### In scope

- A `getIntentStatus` method on the payments port, with both implementations.
- `reconcilePendingOrder`, which asks Stripe whether a pending order was in fact
  paid and completes it if so.
- Extracting the webhook's private `completePaidOrder` so the webhook and
  reconciliation run the *same* post-payment side effects.
- Calling reconciliation when the order confirmation page renders a pending
  order.
- The e2e assertion that would have caught this.

### Out of scope

- **A scheduled reconciler.** Railway runs this service with serverless enabled,
  which already makes scheduled work unreliable here — the reservation-release
  job hit exactly that. A sweeper that may not run is worse than none, because
  it invites trust it has not earned.
- **Reconciling from admin pages.** Same function, different trigger; add it when
  an admin actually needs it.
- **Failed and cancelled payments.** `handleFailure` already covers the failure
  event. This design acts on `succeeded` and leaves every other status alone.
- **Retrying the confirmation email.** Out of band, and a separate concern.

---

## 3. Architecture

| Unit | Responsibility |
|---|---|
| `PaymentsAdapter.getIntentStatus` (new method) | Answers "what does Stripe say this PaymentIntent's status is". Knows nothing about orders. |
| `src/lib/orders/completePaid.ts` (new, extracted) | The post-payment side effects: empty the cart, send the confirmation. One implementation, two callers. |
| `src/lib/orders/reconcile.ts` (new) | Asks Stripe about one pending order and completes it if it was paid. The only new decision-making. |
| `order/[number]/page.tsx` | Calls reconciliation before rendering a pending order. |
| `webhook/route.ts` | Unchanged behaviour; now calls the extracted `completePaidOrder`. |

### Why the confirmation page

The customer is already there. `PendingNotice` polls that exact page five times
over ten seconds waiting for the status to flip, so the page is the one place a
stranded order is reliably observed.

It is done **during render, not in a Server Action**, so it works with
JavaScript disabled. That matters here specifically: the cart stepper, every
form, and the account controls in this codebase were all built to work without
JS, and a money-correctness safety net that only fires for users running
JavaScript is the wrong one to make the exception. A render-time database write
is safe here because the operation is idempotent (§4) — a re-render cannot
double-charge, double-email, or double-clear.

Exposure is bounded by the access gate already on that page: `readGrantedOrderIds`
means only a caller holding the order's httpOnly cookie can reach it, so this
does not give an anonymous visitor a way to make the server call Stripe in a
loop.

### Data flow

1. `/order/1030` renders. Order status is `pending` and it has a PaymentIntent id.
2. `reconcilePendingOrder(order)` asks the payments port for the intent status.
3. Not `succeeded` → return `null`, page renders unchanged as "Awaiting payment".
4. `succeeded` → `markOrderPaid(paymentIntentId, "reconcile:<paymentIntentId>")`.
5. Non-null result → `completePaidOrder(order.id, order.cartId)`: cart emptied,
   confirmation sent.
6. The page reads the order again and renders "Confirmed".

---

## 4. Idempotency

**No new machinery.** `markOrderPaid` already does the work, in one transaction:
it inserts the event id into `stripe_events` with `onConflictDoNothing` and
returns `null` if the row already existed (`orders/index.ts:325`), then returns
`null` again if the order is already `paid` or `fulfilled`
(`orders/index.ts:341-343`).

Reconciliation has no Stripe event id, so it supplies the synthetic key
`reconcile:<paymentIntentId>`. Real Stripe event ids begin `evt_`, so the two
key spaces cannot collide, and the ledger keeps a visible record of which orders
were completed by reconciliation rather than by a webhook.

Both interleavings are safe, and neither needs a lock:

| Order of arrival | What happens |
|---|---|
| Reconcile, then webhook | Reconcile completes the order. The webhook inserts its `evt_` row (no conflict), finds the order already `paid`, returns `null`. Side effects skipped. |
| Webhook, then reconcile | Webhook completes the order. Reconcile inserts its `reconcile:` row, finds the order already `paid`, returns `null`. Side effects skipped. |
| Two renders at once | Both attempt the same `reconcile:` key. The unique insert lets exactly one through; the other returns `null`. |

The confirmation email therefore cannot be sent twice, which is the outcome that
would actually embarrass anyone.

---

## 5. Error handling

`reconcilePendingOrder` **never throws.** It wraps everything and returns `null`
on any failure, logging with the order id.

This is deliberate and it is the opposite of the tradeoff the webhook makes. The
webhook's job is to tell Stripe whether to retry, so it lets some failures
surface. Reconciliation is a page render: a Stripe outage, a network timeout, or
a revoked key must degrade to "we still show Awaiting payment", never to a 500
on the page where a customer is trying to confirm they were charged.

`completePaidOrder` keeps its existing swallow-and-log behaviour for the same
reason it has it today — by the time it runs, the payment is committed and the
order is paid; a failed email must not undo that.

One comment gets corrected. With this design in place, `webhook/route.ts:99`'s
claim that "a stale cart is corrected on the customer's next visit" becomes true
for the first time. It is reworded to name the mechanism rather than imply it
happens by magic.

---

## 6. Testing

`FakePayments` gains `setIntentStatus(paymentIntentId, status)` alongside the
existing `markSucceeded`, so every case below runs with no network.

**`reconcile.test.ts`:**

- A pending order whose intent succeeded becomes `paid`, and its cart is emptied.
  This is order 1030's exact situation and the test that proves the bug fixed.
- A pending order whose intent is `processing` or `requires_payment_method` is
  left `pending`, and its cart is left alone.
- An order already `paid` is a no-op, and **sends no second confirmation email**.
- An order with no PaymentIntent id is a no-op and makes no Stripe call.
- When the payments adapter throws, nothing is mutated and nothing propagates.
- Running reconciliation and then the webhook for the same order sends exactly
  one confirmation — the interleaving from §4, asserted rather than assumed.

**Unchanged and load-bearing:** the existing webhook tests must pass untouched
after `completePaidOrder` is extracted. If extraction required editing them, the
extraction changed behaviour and is wrong.

**e2e:** `e2e/checkout.spec.ts` currently asserts the order reads "Confirmed"
(`:216`) and stops. It gains an assertion that the header cart count clears after
payment. That assertion is the one that would have caught this before it reached
a human.

---

## 7. What this does not fix

Reconciliation fires when someone loads the order page. A customer who pays,
closes the tab immediately, and whose webhook also failed stays stranded until
they return to that page. Note that in exactly this scenario the emailed link is
the thing that does not exist — the missing confirmation email is what defines
it — so `/order-lookup` is the route that actually recovers them.

**A cancelled order is not recovered, and is not even reported.** If the
reservation sweep cancels an expired pending order before the customer returns,
`reconcilePendingOrder` declines at its `status !== "pending"` guard: the page
shows "Cancelled" for an order Stripe captured money on, with no log line
anywhere. If the sweep lands in the narrow window *during* reconciliation's
Stripe call, `markOrderPaid` throws `StrandedPaymentError` instead — that case
is at least logged, under `[reconcile][stranded-payment]`. Today this is
mitigated mainly by the sweep itself being unreliable on this deployment, which
is not a mitigation anyone should rely on. Closing it properly needs the same
`completedAt`-style bookkeeping as retrying side effects.

That residual gap is accepted rather than solved, because closing it means a
scheduled sweeper, and §2 explains why a sweeper is not trustworthy on this
deployment today. Stripe's own ~3-day retry schedule covers the same window from
the other side. If reconciliation ever records a meaningful number of
`reconcile:` rows in `stripe_events`, that is the signal that webhook delivery
itself needs fixing rather than compensating for — and those rows make it
countable.

---

## 8. Success criteria

- A pending order whose payment succeeded becomes `paid` on the next view of its
  confirmation page, with its cart emptied and one confirmation email sent.
- No path can send two confirmation emails for one order.
- A Stripe outage cannot break the order confirmation page.
- Order 1030 reconciles.
- `npm test`, `tsc`, `lint` and the e2e suite are green.
