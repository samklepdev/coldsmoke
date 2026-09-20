# Coldsmoke Plan 1 — Storefront & Checkout

Plan: docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md
Branch: feat/initial-arch
Started: 2026-09-19

## Pre-flight fixes (applied to plan before execution)
- Task 13: `DISCOUNT_COOKIE` moved out of the `"use server"` module into
  `src/lib/cookies.ts` — Next.js rejects non-async exports from server-action files.
- Tasks 9 & 14: wired up `existingOrderId` so resubmitting the checkout address
  reuses the pending order and its reservation instead of stacking a new one.
  User decision. Added `src/lib/orders/reuse.test.ts` (5 tests).

## Progress
Task 1: complete (commits b24dfa5..1874f1f, review clean)
  - Deviations accepted: added `vite` devDep; `!.env.example` in .gitignore;
    @types/node ^20 -> ^22 + engines.node >=22 (removes need for --legacy-peer-deps).
  - Minor findings deferred to final review: 4 moderate transitive npm audit
    vulns; .gitignore missing trailing newline.
  - Controller added docker-compose.yml (dev Postgres, port 54328) + .env so
    Task 2 can migrate without a Neon account. Neon is a connection-string swap.
Task 2: complete (commits 879ba03..609754a, review clean after 1 fix)
  - Fix applied: index on order_items.order_id (Important finding).
  - Controller commit bef663d: synced package-lock with the Task 1 @types/node
    bump, which 1874f1f had left stale (npm ci would have regressed it).
  - Minor deferred to final review: no index on orders.user_id (defer to the
    auth plan that creates the user table).
Task 3: complete (commits dc0eb1e..837b814, approved on re-review)
  - Review found 1 Critical (negative unitPriceCents -> negative total) and
    1 Important (returned lines aliased caller's array). Both were defects in
    the PLAN's code, not implementer error.
  - Fix: reject unitPriceCents < 0 (zero still allowed); deep-copy lines via
    lines.map(l => ({...l})). Shallow [...lines] was tried first and rejected
    as insufficient — it shares the line objects.
  - Plan file patched to match so a re-run does not reproduce the bug.
  - 26 tests passing (23 original, unweakened + 3 new).
Task 4: complete (commits 77e072a..57783f1, review clean after 1 fix wave)
  - Controller commit ea408d3: committed drizzle/meta/_journal.json +
    0001_snapshot.json, which the Task 2 index fix had left untracked. Without
    the journal entry a fresh DB would silently skip migration 0001.
  - Important fixed: redeemDiscount returned void, so a lost race on the
    redemption cap left an order discounted but unrecorded, AFTER the card was
    charged. Now returns boolean; caller logs. Deliberately does not throw —
    throwing in the webhook would make Stripe retry a successful payment.
  - Minors fixed: inclusive boundary tests (startsAt/endsAt == now), fallback
    message test, DB CHECK constraint enforcing lowercase codes (migration 0002).
  - 16 tests passing. Plan + task-9-brief patched for the new boolean caller.
Task 5: complete (commit 53ceb98, review clean, no fixes needed)
  - Reviewer verified the no-inventory-row path against a live DB (not just
    inspection): product appears with available: 0. Postgres GREATEST ignores
    NULLs unless all args are NULL, so the leftJoin is correct.
  - sql<number> cast confirmed safe: onHand/reserved are int4, arithmetic stays
    int4, postgres-js returns a real JS number (no string/NaN leak).
  - getProductsByIds deliberately does NOT filter by active — the cart layer
    checks active itself so it can distinguish deleted from deactivated.
  - Minor deferred to final review: `?? 0` coalesce is dead code given GREATEST
    semantics; availability-shaping SQL duplicated across two call sites.
Task 6: complete (commits fe6d4db..5b69753, review clean after 1 fix)
  - Critical fixed: releaseExpiredReservations cancelled orders unconditionally,
    so a webhook marking an order paid in the gap between the SELECT and the
    per-order transaction got its status overwritten to cancelled. releaseStock
    now returns bool; cancel only when it actually released, guarded by
    status='pending'.
  - Reviewer EMPIRICALLY confirmed the WHERE-clause reservation guard against
    live Postgres (EvalPlanQual re-evaluation under READ COMMITTED).
  - Added 12-racer/5-unit contention test; original 2-buyer test relied on
    incidental scheduling.
  - Controller commit 2ae63fe: dev and test Compose stacks shared a project
    name, so starting test DESTROYED the dev container and remounted its volume.
    Now separate projects/volumes.
Task 7: complete (commit d3dda65, brief's vi.mock path worked, no refactor)
  - Implementer flagged cross-file TRUNCATE races on the shared test DB.
    Controller fixed via fileParallelism: false. Suite now stable 67/67 x3.
Controller fixes applied after Task 7 (from auditing the plan ahead):
  - getCartId() added: read-only cart lookup for Server Components. Next.js
    forbids cookies().set() during render, so the plan's layout/cart/checkout
    pages calling getOrCreateCartId would have thrown on first load.
  - orders.cart_id column + migration 0003, so the webhook can clear the cart
    after payment. clearCart existed and was tested but called from nowhere.
Task 8: implemented (commit b9043fc), review NOT APPROVED — fix QUEUED,
  deliberately held until Task 9 lands (Task 9's tests run against FakePayments).
  - Important 1: createOrUpdateIntent does not guard against updating a
    PaymentIntent already succeeded/canceled. Checkout reuses a pending order's
    PI across address edits, so an edit after success throws a raw Stripe
    invalid_request_error out of a Server Action, untranslated.
  - Important 2: FakePayments overwrites its map with no status tracking, so it
    CANNOT reproduce Important 1 — downstream tests pass while prod breaks.
  - Minor: charge.refunded amountCents reads Charge.amount, not amount_refunded.
  - Confirmed GOOD: calculateTax's taxable base agrees with pricing.quote()
    (both subtotal - discountCents, clamped >= 0); tax_amount_exclusive correct.
  - Deviations accepted: apiVersion 2026-08-26.dahlia (SDK-required literal);
    widened cast in verifyWebhook, contained to stripe.ts.
Controller fix (commit fb19dbd): added ButtonLink. Four call sites nested
  <Button> inside <Link> — invalid HTML, two tab stops per control.
Task 9: implemented (commit 74d8e3f), review found 2 Critical — fix in flight.
  - Critical 1 (CONFIRMED, worse than hypothesised): markOrderPaid inserts the
    event into stripe_events BEFORE finding the order, then returns null if no
    pending order matches — webhook 200s, Stripe never retries, event is
    permanently marked processed. Controller guessed the race was the PI-id
    write gap; reviewer ruled that out (client cannot confirm before it) and
    found the REACHABLE path: releaseExpiredReservations cancels an order while
    Stripe completes a slow payment. Real charge, no order, nothing to
    reconcile. Reviewer verified db.transaction does a true ROLLBACK, so
    throwing undoes the ledger insert.
  - Critical 2: markOrderPaid had ZERO tests. Most safety-critical function.
  - Important deferred to final review: order unitPriceCents not re-validated
    inside orders module (holds by caller convention only); no cleanup if the
    Stripe call fails after the reservation tx commits (relies on expiry sweep);
    discount-cap-exhausted path is console.warn only, not persisted.
Task 8 fix: complete (commit 9958a35). 82/82. FakePayments now tracks status and
  throws PaymentIntentNotUpdatableError like the real adapter.
Controller fix (6c770a1): out-of-stock path now names the product and clamps the
  cart line, per spec section 8. Plan previously returned a generic message and
  corrected nothing.

DEFERRED PRODUCT DECISION for final review:
  /order/[number]?email=... puts customer email in the URL (history, access
  logs, referrer) and the page shows the full shipping address. Suggested
  alternative: short-lived httpOnly cookie for the just-purchased order, email
  param retained only for the emailed-receipt link. Not fixed — it changes
  whether order pages are shareable, which is the owner's call.
Task 9: COMPLETE (commits 74d8e3f..138d1f9, APPROVED on re-review, 0 findings)
  - markOrderPaid now branches on real order state: duplicate event -> null,
    already paid -> null, pending -> proceed, other status -> StrandedPaymentError,
    no order -> OrderNotFoundForPaymentError. Both throws are lexically inside
    the transaction, so the ledger insert rolls back and Stripe retries.
  - Three independent backstops against double-commit confirmed: explicit branch,
    UPDATE ... WHERE status='pending', and commitStock's atomic state claim.
  - Test honesty check: 2 of 6 new tests genuinely fail against old code (the two
    error paths, incl. real rollback verification over a separate pool); other 4
    close the zero-coverage gap without diagnosing Critical 1.
  - Plan fix fe05923: webhook catch must stay broad or the fix is defeated.

QUEUED small fix (apply when src/lib/orders is free):
  markOrderPaid treats status 'fulfilled' as stranded. Unreachable today (nothing
  sets fulfilled until the admin plan), but once fulfillment ships, a late
  payment_intent.succeeded for a fulfilled order would wrongly throw. Treat
  'fulfilled' like 'paid' -> return null.
