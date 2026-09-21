# Admin Foundation and Orders — Design

The first slice of Plan C: the `/admin` boundary and everything needed to run
orders — list, detail, fulfil with carrier and tracking, and refund.

Products, Customers and Discounts are deliberately not here. Each is an
independent section and gets its own spec, plan and implementation cycle.

---

## 1. Why this exists

The store takes money and has no way to act on it. There is no interface to
see an order, mark it shipped, tell the customer it shipped, or give the money
back. Every one of those actions currently requires a database client and a
Stripe dashboard, which is not a way to run a business.

Store design §6 specified an admin panel with four sections. The customer
accounts plan installed its database groundwork — the admin plugin, the `role`
column, `inventory_adjustments`, `discount_codes` — precisely so this phase
needs no migration. This spec spends that groundwork on the orders half.

---

## 2. Scope

### In scope

- `/admin` route group, its layout, and the role gate that protects it.
- `requireAdminUser()` in `src/lib/auth/session.ts`.
- A `db:promote-admin` script, the only way an admin is created.
- Orders list: search and status filter.
- Order detail: items, customer, addresses, payment, refund state.
- `fulfillOrder()` — carrier and tracking, `paid → fulfilled`.
- A shipping confirmation email, and a resend action when it fails.
- `refundOrder()` — full remaining amount, via `PaymentsAdapter.refund()`.
- A `charge.refunded` webhook branch, which is the sole writer of refund state.
- Extending `src/test/plan-drift.test.ts` to cover more than one plan.

### Out of scope

- Products, Customers, Discounts — the other three sections of §6.
- Partial refunds initiated from admin. The Stripe dashboard is the escape
  hatch, and the webhook handles what it produces.
- `proxy.ts`. Store design §6 mentions middleware for a fast redirect; the
  layout check is the security boundary and a proxy is an optimisation. It can
  be added when there is a measured reason.
- Any schema migration. If this slice appears to need one, that is a signal to
  stop and re-read this document.

### Non-goals

- An admin design system. Admin reuses the existing primitives (`Field`,
  `Button`, `ContentPage`) and adds only what orders genuinely require.
- Multi-admin roles or permissions. `role === "admin"` is the whole model.
- An audit log of admin actions. `inventory_adjustments.adminUserId` exists for
  the Products slice; orders need nothing equivalent yet.

---

## 3. Decisions

| Decision | Choice | Why |
|---|---|---|
| Route structure | `src/app/(admin)/` sibling to `(store)` | The store layout wraps everything in storefront chrome. A route group is how this codebase already separates layout concerns. |
| Non-admin response | `notFound()` | A customer cannot discover that `/admin` exists. Consistent with the duplicate-signup and resend-verification paths, which already refuse to confirm anything. |
| Where transitions live | `src/lib/orders/` | Every status change stays in one module, so "what can change an order's status?" is answered by listing one directory. |
| Refunds in admin | Full remaining amount only | One button cannot be misused. Partial refunds remain possible from Stripe, and the webhook handles them correctly. |
| Who writes refund state | The webhook, never the admin action | One writer means a refund issued from the Stripe dashboard lands identically to one issued from admin. |
| First admin | `db:promote-admin` script | Separate from `db:seed`, so seeding products can never grant admin. Holding database credentials is the real authorisation. |
| Fulfilment vs email | Fulfil first, report failure | The parcel shipped whether or not the mail was accepted. |

---

## 4. Architecture

```
src/app/(admin)/admin/
  layout.tsx                 role gate + nav; the security boundary
  page.tsx                   redirect -> /admin/orders
  orders/
    page.tsx                 list: search + status filter
    [id]/
      page.tsx               detail
      actions.ts             fulfillAction, refundAction, resendShippingAction
      FulfillForm.tsx        carrier + tracking
      RefundButton.tsx       full-amount refund

src/lib/auth/session.ts      + requireAdminUser()
src/lib/orders/
  fulfill.ts                 fulfillOrder()
  refund.ts                  refundOrder()
  recordRefund.ts            applied by the webhook
  adminList.ts               listOrdersForAdmin() — reads only
src/lib/email/
  ShippingConfirmation.tsx   template
  shipping.ts                sendShippingConfirmation() -> { delivered }
src/lib/db/promote-admin.ts  npm run db:promote-admin -- <email>
```

### The gate

`requireAdminUser()` sits beside `requireSessionUser()`, where `session.ts`
already says Plan C's admin checks should hang. It returns a `SessionUser` or
does not return at all:

- signed out → `redirect("/sign-in?next=…")`
- signed in, `role !== "admin"` → `notFound()`
- otherwise → the user

`AdminLayout` calls it, mirroring `AccountLayout`. The check is in the layout
because that is the boundary that runs on every render path.

### The orders list

`listOrdersForAdmin({ query, status, page })`, reads only.

- **Search** matches an order number or a customer email. An all-digit query is
  matched against `orderNumber`; anything else is a case-insensitive prefix
  match on `email`. These are the two identifiers a customer quotes when they
  get in touch, which is what the search exists to serve.
- **Filter** is one `order_status` value, or none for all.
- **Order** is newest first by `createdAt`, which is how orders are worked.
- **Page size is 50**, offset-paginated. At this volume a cursor buys nothing,
  and offset keeps the page a plain server component with a URL that can be
  linked and reloaded.

Search and filter are URL search params, not client state, so a filtered list
survives a reload and can be sent to someone.

### Module split

The division inside `src/lib/orders/` is **transition versus query**, not admin
versus store. `fulfill.ts`, `refund.ts` and `recordRefund.ts` change state and
sit beside `markPaid.ts`. `adminList.ts` only reads. This is what keeps the
invariant "only the webhook may move an order to `paid` or `refunded`"
inspectable.

---

## 5. Order lifecycle

```
pending ──payment_intent.succeeded──> paid ──fulfillOrder()──> fulfilled
   │                                   │                          │
   │                                   └────── charge.refunded ────┤
   ▼                                                               ▼
payment_failed                                                 refunded
```

Writers, and nothing else may write these:

| Transition | Written by |
|---|---|
| `pending → paid` | `markOrderPaid()`, from the webhook |
| `pending → payment_failed` | the webhook |
| `paid → fulfilled` | `fulfillOrder()`, from an admin action |
| `paid`/`fulfilled` → `refunded` | `recordRefund()`, from the webhook |

An order may be refunded before or after it is fulfilled. Refunding does not
clear `carrier`, `trackingNumber` or `fulfilledAt`: the parcel really did ship,
and erasing that would destroy the record of it.

---

## 6. Fulfilment

1. `FulfillForm` submits carrier and tracking number.
2. The action validates with zod. Both fields are required — a fulfilment
   without tracking is not worth recording, and the email needs both.
3. `fulfillOrder({ orderId, carrier, trackingNumber })` re-reads the order
   inside the transaction, rejects any status but `paid`, then writes
   `carrier`, `trackingNumber`, `fulfilledAt` and `status`. Commits.
4. `sendShippingConfirmation(order)` returns `{ delivered }`.
5. The action returns `fulfilled`, or `fulfilled-undelivered` when the send was
   rejected.

Step 4 can never undo step 3. On `fulfilled-undelivered` the detail page shows
the fulfilment as done, plus a notice and a **Resend shipping email** action.

This is the third distinct answer in the codebase to "what happens when an
email fails", and each is deliberate:

| Caller | Behaviour | Why |
|---|---|---|
| `sendOrderConfirmation` | swallow, log | A failed email must not fail a Stripe webhook and cause a retry. |
| Sign-up / resend verification | tell the customer | They are waiting for that mail and can act. |
| Fulfilment | commit, then tell the admin | The parcel shipped regardless; a human can resend. |

---

## 7. Refunds

The admin action moves money and writes no status. The webhook writes status
and moves no money.

1. `refundOrder({ orderId })` re-reads the order, requires `paid` or
   `fulfilled`, computes `amountCents = totalCents - refundedCents`, and calls
   `payments.refund()` with an idempotency key:

   ```
   refund:${orderId}:${amountCents}
   ```

   Two fast clicks therefore return the same refund object instead of a second
   refund or a raw Stripe rejection.

2. The UI reports "Refund submitted. Stripe will confirm it shortly." The order
   still reads `paid` or `fulfilled` until the webhook arrives. This is honest:
   the refund is not final until Stripe says so.

3. `charge.refunded` arrives. `recordRefund()` runs **in the same transaction
   as the `stripe_events` insert**, exactly as `markOrderPaid()` does.

### The cumulative rule

`verifyWebhook()` already maps `amount_refunded` for `charge.refunded`. Stripe
reports that field as the **cumulative** total refunded for the charge, not the
amount of one refund. Therefore:

```
refundedCents = event.amountCents          // set, never +=
status = refundedCents >= totalCents ? "refunded" : unchanged
```

Accumulating would be wrong: two partial refunds of 1000 and 1500 arrive as
`1000` then `2500`, and `+=` yields `3500`. A test pins this so the
"simplification" to `+=` fails loudly.

A `charge.refunded` for an unknown payment intent throws, like
`StrandedPaymentError`: non-2xx, the ledger row rolls back, Stripe retries and
surfaces it. Money that moved with no order behind it is never swallowed.

---

## 8. Error handling

| Case | Behaviour |
|---|---|
| Fulfil an order that is not `paid` | `OrderNotFulfillableError` → field message. Re-read inside the transaction, so a stale tab cannot drive it. |
| Refund an order that is not `paid`/`fulfilled` | `OrderNotRefundableError` → field message. |
| Double-click Refund | Idempotency key returns the original refund. No second charge, no error. |
| Stripe refund call fails | Nothing written, order untouched, message shown, retry is safe — the action writes no status. |
| Shipping email rejected | Fulfilment stands. Notice plus resend action. |
| `charge.refunded`, unknown intent | Throws → non-2xx → Stripe retries. |
| Non-admin reaches `/admin` | `notFound()`. |

---

## 9. Testing

**Domain, vitest against real Postgres** (`testDb`, as `markPaid.test.ts`):

- `fulfillOrder()` rejects every status but `paid`; writes all four fields.
- `refundOrder()` rejects anything not `paid`/`fulfilled`; asserts
  `FakePayments.refund` received `totalCents - refundedCents` and the
  idempotency key.
- `recordRefund()` is idempotent on replay via the ledger.
- **The cumulative rule**: events carrying `1000` then `2500` leave
  `refundedCents = 2500`, not `3500`; the order stays `paid` after the first
  and becomes `refunded` only after the second.

**Server Actions, vitest with mocked email** (mirroring
`sign-up/actions.test.ts`): `fulfillAction` returns `fulfilled-undelivered`
when the send reports `delivered: false`, **and the fulfilment is still
committed** — the assertion that a mail outage cannot lose a shipment.

**Route guard, Playwright** in `e2e/admin.spec.ts`, beside
`e2e/accounts.spec.ts` where route protection is already tested: signed out
redirects to sign-in; a signed-in customer gets a 404; an admin sees the list.
The 404 is the security assertion and belongs where the real layout runs.

**Email template, vitest** (mirroring `render.test.ts`): `ShippingConfirmation`
renders the carrier and tracking number.

**Plan drift.** `src/test/plan-drift.test.ts` currently pins one plan via a
single `PLAN` constant. It is generalised to a list of plans, each parsed and
checked as today, so this plan cannot silently diverge from shipped code the
way earlier ones did.

---

## 10. Risks

**No admin exists until the script is run.** `/admin` 404s for everybody,
including the owner, until `db:promote-admin` is run against an account that
has already signed up. The script must say so plainly when the email is not
found rather than failing obscurely.

**Email is not currently deliverable.** No sending domain is verified in
Resend, so the shipping confirmation will be rejected exactly as every other
mail is. The design already tolerates this — fulfilment commits and the failure
is surfaced — but the notice will fire on every fulfilment until a domain is
verified. That is a configuration blocker, not a defect in this slice.

**The refund is asynchronous.** An admin who refunds and immediately reloads
sees the order still `paid`. This is correct but can read as a failure; the UI
must say that Stripe confirms it, not merely that something was submitted.
