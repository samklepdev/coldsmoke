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
Task 10: COMPLETE (commit 91859c0, review clean, 0 Critical/Important)
  - Deviation accepted: JSX form <OrderConfirmation order={order} /> instead of
    the brief's function-call form; resend's types expect a ReactElement.
    Required index.ts -> index.tsx.
  - Verified: getResend() is INSIDE the try, so a missing RESEND_API_KEY cannot
    escape and fail the Stripe webhook. Colour hexes match tokens.css exactly.
  - Template rendered to HTML and checked for order number, items, total, address.
Controller commit ef0b9cf: APPROVED separately.
  - markOrderPaid treats 'fulfilled' as idempotent alongside 'paid'. Reviewer
    confirmed it cannot mask a stranded payment — any path to fulfilled must
    pass through paid first.
  - getCatalogProductById correct; zero callers until Task 14 consumes it.

QUEUED small fix (batch with the next src/lib change):
  orders.shippingAddress / billingAddress are jsonb with no .$type<Address>(),
  so every read casts `as Address` with nothing validating the shape. Adding
  .$type<Address>() to the schema is type-only (no migration) and removes the
  blind casts. A malformed address currently renders blank rather than erroring.
Task 11: complete (commit 6a10c81) + controller a11y fix.
  - Implementer measured contrast as instructed and self-reported a FAILURE
    rather than asserting compliance: --text-faint 3.44:1 (needs 4.5:1).
    Controller independently computed the same 3.44 before seeing the report.
  - Controller found a THIRD failure neither had flagged: the form input border
    (--line on --panel) at 1.70:1, needs 3:1. That is the checkout form.
  - Fixes: --text-faint #63666d -> #82858d (5.36 ground / 4.84 panel);
    --line-bright #4a4b51 -> #65666e (3.47 / 3.13); Field input border switched
    from --line to --line-bright. --line stays as-is for dividers, which are
    decorative and exempt from 1.4.11.
  - Plan patched so Tasks 12/13 quantity inputs use --line-bright too.
Task 11: COMPLETE (commit 6a10c81 + a11y fix 8db2b76, review clean)
  - Reviewer INDEPENDENTLY recomputed the contrast fix: 5.36 / 4.84 / 3.46 /
    3.13, matching the controller's figures. Confirmed no other failing pair;
    remaining --line uses are decorative dividers, outside WCAG 1.4.11.
  - Verified: layout never imports getOrCreateCartId (no cookie write during
    render); Button/ButtonLink never nest; Field's aria-describedby cannot
    dangle because error span and attributes share one condition.
  - Minor deferred: Wordmark's aria-label on the span is redundant (duplicates
    its own text, and SiteHeader's Link aria-label overrides it) — remove it.
  - Minor noted: --line-bright on --panel is 3.13:1, only 0.13 over the floor.
    Revisit if --panel is ever lightened.
Task 12: COMPLETE (commit de25ec4 + fix ae3f8a4)
  - Code matched the brief; the scaffold home page was already removed in
    7e244af. Review found one Important defect in the plan's own code.
  - Important fixed: addToCartAction guarded with Number.isFinite, but addItem
    throws on anything that is not a positive integer. Number("") === 0 is
    finite, so clearing the quantity box threw a raw error out of a Server
    Action. parseQuantity now rejects blank input SEPARATELY from zero —
    important because on the cart page zero means "remove this line", so a
    cleared field would otherwise have silently deleted it. That distinction
    was found by a test failing, not by inspection.
  - Also capped quantity at MAX_LINE_QUANTITY (99): cart_items.quantity is
    int4 with no CHECK, so an unbounded value overflows the `quantity + n`
    upsert. Product page max attribute now agrees with the server.
  - 11 tests added, 6 fail against the pre-fix code.

KNOWN 404s (user decision: leave, a later plan adds the pages):
  /the-scent (SiteHeader + home hero CTA) and /about (SiteHeader) have no
  routes and the plan never creates them. Both are live links in the primary
  nav today.
Task 13: COMPLETE (commit 416d07b)
  - Deviation: a rejected discount code now revalidates /cart. The brief only
    revalidated on success and on clearing, but the failure branch also
    DELETES the cookie — so replacing a valid code with an invalid one left
    the totals showing a discount that no longer existed.
  - Deviation: inline styles moved into the CSS module, matching the rest of
    the codebase.
  - Verified against the running app, not just tests: $45 cart -> $6 shipping
    + "$5.00 more"; adding the $6 sample -> Free at $51; applying smoke10 to
    that $51 cart -> discount $5.10, post-discount subtotal $45.90, shipping
    back to $6.00, total $51.90. Confirms a discount cannot buy free shipping
    and that the countdown uses the same basis quote() does.
  - 10 tests added covering the action's cookie writes and re-validation.
Task 14: COMPLETE (commit fa7d57b)
  - Deviation: state validated /^[A-Za-z]{2}$/ + uppercased, not length(2).
    length(2) accepted "12" and passed "tx" through as typed — and this value
    goes straight to Stripe Tax. 2 tests fail against the brief's schema.
  - Deviation: line2 trims to undefined; an untouched optional input posts ""
    which would have been stored as a blank address line.
  - Deviation: router.replace + refresh instead of window.location.href. The
    back button must not return to a checkout form for an order already paid,
    and eslint rejects location assignment for internal routes in Next 16.
  - Payment Element appearance remapped to real tokens — the brief used
    #e4e7ec and #b7bbc1, which are not tokens at all. All mapped pairs
    recomputed against --panel: 12.15 / 5.65 / 3.13, all pass AA.
  - autocomplete added to all 7 address fields (brief had none).
  - 11 tests: validation, order creation, pending-order reuse across an
    address edit (asserts ONE order and ONE reservation), both out-of-stock
    branches.
Task 15: COMPLETE (commit a9beee6)
  - Deviation: post-payment side effects isolated from the outer catch.
    markOrderPaid has COMMITTED by then, so a clearCart/email failure returned
    500 for a payment that actually succeeded — and Stripe's retry is a
    guaranteed no-op (already-processed event -> null), so the side effects
    never ran anyway. Outer catch deliberately left broad per fe05923.
  - Deviation: cron route fails closed on unset CRON_SECRET. The brief
    compared against `Bearer ${undefined}`, so sending the literal string
    "Bearer undefined" authenticated. Now timing-safe as well.
  - Latent defect found BY the tests, fixed at source: createPendingOrder
    returned the order row captured before stripePaymentIntentId was written,
    so that column was always null on the returned object. No caller read it
    yet — which is why it was worth closing rather than working around.
  - Queued schema fix landed: shipping/billing addresses now .$type<Address>()
    (type-only, no migration), removing 4 blind `as Address` casts.
  - 13 tests across both routes.

BLOCKED — needs real Stripe test keys:
  .env holds sk_test_placeholder / pk_test_placeholder / whsec_placeholder.
  Confirmed by calling StripePayments.calculateTax directly:
  StripeAuthenticationError "Invalid API Key provided: sk_test_*******lder".
  Consequences: Task 14 Step 4 (pay with 4242…) and Task 15 Steps 4-5
  (stripe listen / stripe events resend) could not be run. The failure path
  degrades correctly — the error is not an OutOfStockError, so it lands in the
  generic catch and the customer sees "We couldn't start checkout." Every
  payment path is covered against FakePayments instead.
