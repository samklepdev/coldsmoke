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
Task 16: COMPLETE (commit ff9bf3d)
  - Deviation: order-lookup split into a Server Component page + client form
    so it can export metadata; the brief made the whole page a client
    component, which cannot.
  - Access control verified against the running app, not by inspection:
    correct email 200, different-case email 200, wrong email 404, missing
    email 404, non-existent order number 404.
  - 7 tests on the lookup action, including that a wrong email and a
    non-existent order number produce the IDENTICAL message — otherwise the
    form is an order-number oracle.
Task 17: COMPLETE (commit 2ae8033)
  - Deviation: the brief's single paying test cannot pass without real Stripe
    keys. Split into three tests that run today (shop -> cart -> checkout
    form; quantity update surviving reload with totals recalculating; empty
    cart bounced from /checkout) plus the brief's payment test kept verbatim
    behind test.skip with a stated reason. It self-enables when a real
    STRIPE_SECRET_KEY appears.
  - 3 passed, 1 skipped.
Task 18: COMPLETE (commit pending)
  - Full suite green: 140 vitest tests, tsc clean, lint clean, production
    build clean, 10 routes.
  - README documents the two live caveats (placeholder Stripe keys, the
    /the-scent and /about 404s) rather than describing an ideal state.

PLAN 1 COMPLETE — 18/18 tasks.

STILL OPEN for the owner:
  1. DEFERRED PRODUCT DECISION (carried from Task 9, unchanged): the order
     page takes the customer email as a URL query param, so it lands in
     browser history, server access logs, and referrer headers — and the page
     renders the full shipping address. Alternative: a short-lived httpOnly
     cookie for the just-purchased order, keeping the email param only for
     the emailed-receipt link. Not changed: it decides whether order pages
     are shareable, which is the owner's call. Implemented as planned.
  2. Real Stripe test keys, to close out Task 14 Step 4 and Task 15 Steps 4-5
     and un-skip the Playwright payment test.
  3. /the-scent and /about 404s (owner chose to leave them for a later plan).
  4. Minors deferred across earlier tasks and never revisited: 4 moderate
     transitive npm audit vulns (Task 1); no index on orders.user_id (Task 2,
     defer to the auth plan); dead `?? 0` coalesce and duplicated
     availability SQL across two call sites (Task 5); Wordmark's redundant
     aria-label (Task 11); --line-bright on --panel at 3.13:1, only 0.13 over
     the floor (Task 11).

## Post-completion: propagating fixes back into the plan (2026-09-20)

Caught a process failure of my own. Tasks 3, 4, 9 and 11 each patched the plan
after a review found a defect in it ("Plan file patched to match so a re-run
does not reproduce the bug"). I fixed five defects across Tasks 12-18 and
patched NONE of them back. The plan still contained every one.

Propagated all five into the plan and the task briefs:
  1. Number.isFinite quantity guard -> parseQuantity (plan + task-12-brief),
     plus MAX_LINE_QUANTITY in the cart module (plan + task-7-brief) and the
     product page's max attribute.
  2. z.string().length(2) -> letters-only regex + uppercase transform
     (plan + task-14-brief).
  3. Cron `Bearer ${process.env.CRON_SECRET}` -> fail-closed + timingSafeEqual
     (plan + task-15-brief).
  4. Inline post-payment side effects -> completePaidOrder, isolated from the
     outer catch (plan + task-15-brief).
  5. createPendingOrder returning the pre-update row -> .returning()
     (plan + task-9-brief; the first sweep missed the brief, the verification
     step caught it).
  6. Typed jsonb addresses .$type<Address>() (plan + task-2-brief).

Verified by extracting the plan's code blocks and diffing against the shipped
source, not by eyeballing: src/app/api/stripe/webhook/route.ts and
src/app/api/cron/release-reservations/route.ts are now byte-identical to the
plan. All five defect patterns are absent from the plan and every task brief.

Also fixed: the plan told the implementer to create src/lib/email/index.ts,
but Task 10's accepted deviation renamed it to .tsx (resend's `react` field
wants a ReactElement, so the file contains JSX). Plan and task-10-brief now
say .tsx with the reason inline, and use the JSX call form.

### Systemic finding — plan drift is wider than these five

Diffing every "Create `path`" block in the plan against the repo:
  35 files byte-identical, 31 files differ, 0 files missing.

The 31 are accumulated accepted deviations and review fixes from Tasks 1-11
plus my own from 12-18, none propagated. Biggest gaps: orders/index.ts (~63
changed lines), payments/stripe.ts (~51), inventory tests (~96),
CheckoutForm.tsx (~105), e2e/checkout.spec.ts (~85). The plan is a reliable
guide to 35 files and an actively misleading one for 31.

NOT fixed — the script to re-check this lives at scratchpad/plan_drift.py and
is cheap to re-run. Deciding whether the plan should be a living document or
a historical artefact is the owner's call.

## Order page access: cookie instead of email-in-URL (2026-09-20)

Owner decision on the deferred Task 9 item: short-lived httpOnly cookie.

The email template turned out to contain NO link, so ?email= existed purely
for two in-app flows I control. That let the parameter be removed entirely
rather than kept as a fallback.

Design note worth keeping: the cookie holds order IDS, not order numbers.
orders.id is a v4 UUID, so the cookie value is itself the credential. A cookie
naming "CS-1000" would be trivially forgeable — httpOnly stops page scripts,
not a hand-written request. The grant check is an inArray in the WHERE clause
(findOrderByNumberForIds), so there is no code path that reads an order
without a credential, and an empty grant list short-circuits rather than
degrading to "no filter".

Verified over HTTP against the running app:
  ?email=correct 404 | ?email=wrong 404 | no credential 404
  correct cookie 200 | forged cookie 404 | empty 404 | other order's id 404
11 new tests on the access module, plus grant assertions in the checkout and
lookup action suites. 154 tests total.

Propagated into the plan and briefs in the same pass this time (tasks 9, 13,
14, 16). 39 files now byte-identical to the plan, up from 35.

### Flaky e2e test — found, misdiagnosed once, then fixed

"the cart survives a reload" failed ~1 run in 4. First diagnosis was wrong: I
called it environmental (stale .next after interleaving next build and next
dev) because I could not reproduce it, and it had passed 8 runs straight.
Kept running it, and it failed 1-in-6 — genuinely flaky, not environmental.

The guard I had added first was worse than nothing:
  await expect(page.getByLabel(/^Quantity of /)).toHaveValue("2");
The quantity input is UNCONTROLLED, so it holds the typed "2" whether or not
the action landed. That assertion passes in both the good and bad cases.

The failure snapshot showed the real shape: header read "Cart (2)" while the
body still read quantity 1 / Subtotal $45.00 — the write had landed, and the
test was racing the server re-render, not the database. Fixed by waiting on
the server-rendered total ($90.00) before reloading. 15/15 clean after,
having been ~1-in-4 before.

Lesson to carry: an assertion that cannot fail is indistinguishable from
green. Check what a guard is actually reading before trusting it.

## Deferred minors from progress.md item 4 (2026-09-20)

1. npm audit — ACCEPTED, not fixed, documented in the README. All 4 moderate
   findings are GHSA-67mh-4wv8-2f99 (esbuild's DEV SERVER accepts cross-origin
   requests), reaching us transitively through drizzle-kit, a devDependency
   used only by `npm run db:generate`. Nothing here starts an esbuild dev
   server and it never touches a deployed artifact. `npm audit fix --force`
   installs drizzle-kit@0.18.1 — a downgrade across 13 minor versions that
   breaks the current config format. Forcing it is worse than the finding.
2. orders.user_id index — still deferred, and confirmed correct to defer. The
   column is nullable with no users table and no query filtering on it; an
   index over an all-NULL column is pure overhead.
3. Catalog duplication — FIXED. The availability expression is now a single
   shared `availableExpr` used by all three reads, and the dead `?? 0`
   coalesce is gone from all three call sites.
   Task 5's review had verified the no-inventory-row case against a live DB
   but left NO test, so the claim the coalesce depends on was unpinned. Added
   src/lib/catalog/catalog.test.ts (10 tests) covering it directly, plus the
   arithmetic, the zero floor, the numeric type, agreement across all three
   reads, and the deliberate active-filtering asymmetry (by-id resolves an
   inactive product; by-slug does not).
4. Wordmark aria-label — FIXED, removed. It duplicated the element's own text
   and was overridden by SiteHeader's link label anyway.
5. --line-bright on --panel at 3.13:1 — no action, correctly a watch item. It
   passes the 3:1 floor for non-text contrast; the note stands as a warning
   against lightening --panel.

164 tests, tsc clean, lint clean, 10 routes, e2e 3/3 across three runs.
40 files now byte-identical to the plan, up from 35 at the start of the day.

## Plan drift resolved, and guarded (2026-09-20)

Owner decision: living document plus an automated guard.

Before: 35 of 67 plan code blocks matched the shipped source.
After:  66 of 67. The remaining one is a declared partial.

Sequence:
1. Removed an exception instead of encoding it. cookies.ts was created in
   Task 13 but CART_COOKIE first appears in Task 7, so Task 7's cart/index.ts
   could never match the shipped file without importing a module that did not
   exist yet. Moved the module's creation to Task 7 (new Step 0) and dropped
   Task 13's retrofit step. Task 7 now matches exactly.
2. Synced 26 files across 52 blocks (plan + briefs) from the shipped source.
3. Rebuilt the two actions.ts blocks by hand. That file is genuinely created
   in Task 12 and appended to in Task 13, so its Create block MUST be an
   intermediate state. Both halves are now derived from the shipped file, and
   the Create block carries a `<!-- plan-drift: partial — reason -->` marker.

The guard is src/test/plan-drift.test.ts, so it runs in `npm test` and CI:
  - Create blocks without a marker: byte-for-byte equality with the file.
  - Partial and Append blocks: every line of code must still appear in the
    shipped file, in order. Imports excluded, since later tasks merge them.
  - Partial blocks must carry a stated reason, and are capped at 3 so the
    holes in the guarantee cannot multiply quietly.

VERIFIED THE GUARD ACTUALLY BITES, rather than trusting a green run — the
lesson from the uncontrolled-input assertion earlier today. Three probes:
  A. source changed, plan untouched  -> 1 failed  (the real-world failure)
  B. plan changed, source untouched  -> 1 failed
  C. drift inside the PARTIAL block  -> 1 failed  (weaker rule still bites)
  D. baseline restored               -> 72 passed

Suite is now 236 tests, of which 72 are this guard's parameterised cases.

## Stripe: real test keys in place, webhook verified live (2026-09-20)

Owner supplied real test keys. STRIPE_SECRET_KEY and the publishable key are
now 107 chars and authenticate; RESEND_API_KEY is real too. I never handled
their values — the webhook secret was obtained via `stripe listen
--print-secret` and written into .env by a pipeline that never echoed it.

Stripe CLI 1.51.0 installed via Homebrew. It authenticates from the key
already in .env via STRIPE_API_KEY, so no interactive `stripe login`.

PLAN DEFECT FOUND AND FIXED: the plan's `stripe listen --forward-to ...`
no longer works. CLI 1.51 exits with "must specify events to forward using
--events, --all-snapshot, or --all-thin". Updated in the plan, README and 3
briefs to pass
  --events payment_intent.succeeded,payment_intent.payment_failed,charge.refunded
This class of rot is invisible to the drift guard, which only checks code
blocks that name a source file — shell commands in prose are unguarded.

VERIFIED LIVE against real Stripe (previously only against FakePayments):
  - Signature verification passes with the real whsec. A wrong secret would
    have produced 400; we got 500, so the signature path is genuinely
    exercised.
  - `stripe trigger payment_intent.succeeded` for a PaymentIntent with no
    matching order -> 500, and stripe_events stayed EMPTY. That is the Task 9
    Critical-1 fix — the ledger insert rolling back so Stripe retries rather
    than the event being marked processed for a charge with no order. First
    confirmation of it outside the fake.
  - `stripe trigger payment_intent.payment_failed` -> 200, and the event IS
    recorded in stripe_events. The designed asymmetry holds: succeeded-with-
    no-order must retry, failed must not.
  - `stripe listen` reports API version 2026-08-26.dahlia, matching the
    adapter's pinned apiVersion.

BLOCKED — needs an account setting only the owner can make:
  Stripe Tax is `status: pending`, `missing_fields: ["head_office"]`.
  createPendingOrder calls calculateTax and blocks by design when it fails, so
  NO checkout can complete until an origin address is set under
  Dashboard -> Settings -> Tax. Owner is doing this. Until then the card flow,
  the paid transition, and the Playwright payment test remain unverified.
  The business has no address yet — the brand plan still has [Street],
  [City, ST ZIP] placeholders and the LLC is not formed.

## Stripe end-to-end VERIFIED (2026-09-20)

Owner set the Tax head office (Houston, TX). Everything previously blocked is
now confirmed against real Stripe.

Task 14 Step 4, Task 15 Steps 4-5, Task 17 — all complete:
  - Real card 4242… pays. Order 1013: status paid, inventory_state committed,
    paid_at set, on_hand 50 -> 49, cart cleared, confirmation page shows
    "Confirmed".
  - Replay of the same event (`stripe events resend`) -> 200, on_hand and
    reserved unchanged, still one ledger row. Idempotency proven, not assumed.
  - Cron sweep exercised live for the first time: 401 with no header, 401 with
    a wrong secret, 200 with the real CRON_SECRET, releasing 9 expired
    reservations (reserved 12 -> 3, 9 orders cancelled, on_hand untouched).
  - e2e now 5/5 including the real payment.

FOUR DEFECTS FOUND, all in my own work:

1. The Playwright payment test could never have run. Its skip guard reads
   process.env.STRIPE_SECRET_KEY, but the Playwright runner does not load
   .env — only `next dev` does. So it was always undefined and the test
   skipped itself forever, including with real keys. Fixed by importing
   dotenv/config in playwright.config.ts. Same family as the uncontrolled-
   input assertion: a check that silently never fires.

2. CART QUANTITY BUG, reported by the owner and reproduced. A cleared
   quantity box submitted happily and nothing changed — no error, no update.
   I introduced this in ae3f8a4: setQuantityAction refuses unparseable input
   by re-rendering instead of deleting the line, which is right, but silent.
   I even wrote a test locking the silence in. Fixed with `required` + `step`
   on the input, so constraint validation refuses blank the same way it
   already refused 2.5, -1 and >99. Every invalid case now states a reason.
   New e2e regression test covers it.
   NOTE: this is the same symptom I dismissed as a test race yesterday when
   the flaky test showed header "Cart (2)" beside a $45.00 body. The race was
   real, but so was a bug sitting next to it.

3. The payment test's Pay click silently missed. Selecting Card expands the
   Payment Element ~570px, pushing the button from y=688 to y=1261; Playwright's
   auto-scroll raced the reflow and the click landed on nothing. A missed click
   is not an error, so it looked like the button did nothing. Fixed with
   scrollIntoViewIfNeeded + toBeInViewport before clicking.

4. The payment test asserted only the redirect, so it passed while the order
   was still "Awaiting payment". It now asserts "Confirmed", which is the only
   assertion that actually proves the webhook marked the order paid.

Also: the Payment Element opens on a method picker (Card, Cash App, Affirm,
Klarna…), so the card fields do not exist until Card is selected, and two
iframes share the title "Secure payment input frame" — frameLocator is strict
and throws, so .first().contentFrame() is required. The plan's placeholder
guesses were correct; the surrounding steps were not.

OPEN: zero tax registrations, so calculateTax returns 0 for every destination.
Correct behaviour (Stripe only charges where registered) but it means no sales
tax is collected. Needs registrations before live. Documented in the README.

# ============================================================
# PLAN 2 — Cart Quantity Stepper (2026-09-20)
# Plan: docs/superpowers/plans/2026-09-20-cart-quantity-stepper.md
# Branch: feat/cart-stepper
#
# NOTE: the "Task N: complete" lines ABOVE this banner belong to PLAN 1
# (storefront & checkout). Plan 2's entries are prefixed "Stepper Task N"
# so a resumed session cannot confuse the two.
# ============================================================
Stepper Task 1: complete (commits 77472e1..fc061f2, review clean after 1 fix)
  - src/lib/cart/limits.ts extracted; index.ts re-exports it. All three
    existing importers unchanged and still resolve through the barrel.
  - PLAN DEFECT found by the implementer, not by me: Task 1 changes
    src/lib/cart/index.ts, which the drift guard tracks, but my Global
    Constraints named only cart/page.tsx and deferred all syncing to Task 5.
    That would have left the suite RED across Tasks 2-4, where a known
    failure masks each implementer's own breakage. Plan restructured so every
    task syncs the plan for whatever tracked file it touches, in the same
    commit. The implementer escalated DONE_WITH_CONCERNS rather than
    weakening the test — correct behaviour.
  - limits.ts is now itself drift-tracked: guard went 72 -> 73 checks.

OPERATIONAL HAZARD (cost ~15 min of false alarm):
  Running `npm test` while a subagent is also running it produces ~21 FK
  violations ("Key (product_id)=... is not present in table products").
  Both processes TRUNCATE the same test database in beforeEach.
  vitest.config.ts sets fileParallelism:false, which serialises files WITHIN
  a run but does nothing across processes. Under subagent-driven development
  concurrent runs are the norm, not the exception.
  Rule: the controller does not run npm test while any subagent is live.
  A real fix would be a per-process database or an advisory lock; not done.
  - Review found 1 Important: commit c179b0e force-added
    .superpowers/sdd/task-7-brief.md past the directory's `*` gitignore.
    The reviewer attributed it to implementer scope creep; that was wrong —
    MY fix dispatch named that path in its `git add` line, so the agent used
    -f to comply and said so. Controller defect, not implementer error.
    Resolved in fc061f2: untracked the file (kept on disk), and the stepper
    plan now targets only the tracked plan document, stages no brief, and
    states that briefs are generated by task-brief and never hand-edited or
    force-added. plan-drift.test.ts only reads the plan markdown, so the
    brief never affected the test the sync existed to fix.
  - Minor logged for the final review: task-1-report.md's diff-stat summary
    for index.ts disagrees with the actual diff (report-only inaccuracy).
  - Second controller defect caught while waiting: I changed the Global
    Constraint to "every task syncs in the same commit" but only gave Task 1
    a sync step, while Tasks 2-4 each touch a tracked file and Task 5 still
    did all the syncing at the end. Tasks 2-4 now sync their own file; Task 5
    is repurposed as full verification. Briefs regenerated from the corrected
    plan — the previously extracted ones were stale.

Stepper Task 3: complete (commit 971b921)
  - page.tsx now renders <QuantityStepper />; Plan 1 synced in the same commit.
  - PLAN DEFECT: Task 3 Step 2 gave an "exactly" import block that omitted
    DiscountForm, which page.tsx still renders. Applying it literally would
    have failed with an undefined name, not the unused-import error Step 3
    predicted. Kept the import.
  - Verified in the browser: 3 -> 2 -> 1 via the stepper, subtotal tracking
    each step ($135 / $90 / $45), shipping flipping Free -> $6.00 with the
    "$5.00 more for free shipping" note returning at 1, and - correctly
    disabled at quantity 1. No Update button anywhere.

Stepper Task 4: complete (commit 8f503e9)
  - Three stepper tests replace the free-text-box test.
  - PLAN DEFECT: the plan said one test drove the removed input and to "leave
    the other four alone". Two did — `the cart survives a reload and totals
    recalculate` also used getByLabel(/^Quantity of /).fill() and the Update
    button. Fixed it too, and rewrote its comment, which justified asserting
    on the server total because the input was *uncontrolled*; the reason still
    holds but the mechanism is now an *optimistic* count.
  - TEST DEFECT in the plan's own supplied code: it asserted
    getByText("$45.00").first() to wait for the decrement, but "$45.00" is
    also the unit price ("$45.00 each"), visible at every quantity. The
    assertion passed instantly and the subtotal read raced ahead of the
    server — it failed on first run with 90.00. Replaced with
    expect.poll(subtotal). Same family as the two "assertion that never
    fires" bugs logged on 2026-09-20.

Stepper Task 6: THE NO-JS CHECK FOUND A REAL BUG (commit 1b8e208)

  This is the task that justified itself. Nothing in the automated suite
  covers JavaScript being off, and with it off the stepper was inert:
  clicking + left the quantity at 1 and the subtotal at $45.00.

  Cause: QuantityStepper passed `action={submit}`, a client async function
  wrapping setQuantityAction, so it could call useOptimistic first. Next only
  emits the native form POST — method, URL, hidden action id — when it can
  see a Server Action in `action`. Wrapped, the form submitted nowhere.
  The buttons were `type="submit"` exactly as the plan's Global Constraint
  demanded, so the markup satisfied the letter of the constraint while
  failing its entire purpose. Reading the JSX could not have caught this;
  only turning JavaScript off did.

  Worth noting: the broken version is React's own documented useOptimistic
  example (node_modules/next/dist/docs/01-app/02-guides/forms.md:386). The
  docs never claim that pattern degrades — the progressive-enhancement
  guarantee is stated separately, for forms whose action IS a Server Action.

  Fix: pass setQuantityAction directly and read the in-flight FormData with
  useFormStatus in a child component of the form. Same instant count, native
  POST preserved. useFormStatus only reports on a form it is rendered inside,
  hence the StepperControls split.

  Verified with a JS-disabled Chromium context, 9/9 checks:
    quantity 1 / subtotal $45.00 on load; - disabled at 1; + -> quantity 2,
    subtotal $90.00, shipping Free; - -> quantity 1, subtotal $45.00;
    Remove -> "Your cart is empty." Each click is a full round trip with no
    optimism, which is the expected degraded behaviour.

  Both plans were corrected so a re-run cannot reproduce the defect: the
  Plan 1 code block, the Plan 2 code block, the Architecture note, the Tech
  Stack line, the Global Constraint (which now says wrapping the action is as
  fatal as an onClick and must be checked with JS off, not by reading
  markup), and the Self-Review's error-handling and known-risk notes.

  The blank-quantity bug reported on 2026-09-20 is now structurally
  impossible rather than guarded — there is no free-text box to clear.

## Task 9's three deferred Importants, finally closed (2026-09-20)

These were flagged Important during Task 9 and deferred to a "final review"
that never happened. All three were still live in the code. Branch
fix/order-path-hardening, one commit each, test-first.

1. ORDER PRICES WERE NEVER RE-VALIDATED (commit 6960b6c).
   createPendingOrder's doc comment promised the amount comes from database
   prices and "never from anything the client sent". That held only because
   every caller happened to build lines from getCartLines — a convention
   nothing enforced. The RED test proved the hole: a line claiming
   unitPriceCents: 1 for a $45 product wrote an order with subtotalCents: 1.
   Lines are now re-read from the catalogue and REJECTED on mismatch rather
   than silently re-priced — charging the caller's figure bills a price the
   catalogue never offered, charging the catalogue's bills a price the
   customer never saw. Deleted and deactivated products are rejected too;
   they previously surfaced as an FK violation from inside the insert.
   Runs before the tax call and before any reservation, so a rejected order
   costs neither a Stripe round trip nor stock to reclaim.
   Mutation-checked: removing the guard fails 6 of 7 tests.

2. A FAILED PAYMENT INTENT ORPHANED THE RESERVATION (commit 3be065c).
   The reservation transaction commits before createOrUpdateIntent runs. If
   that threw, the order sat pending with stock held against a payment that
   would never arrive until the expiry sweep — and retrying stacked a second
   reservation (test saw reserved go to 2). Now cancels the order and releases
   the stock, reaching exactly the state the sweep produces so nothing
   downstream needs a new case. A cleanup failure is logged and swallowed:
   the sweep is still the backstop, but masking the caller's error is not
   recoverable. Test asserts the original error propagates.

3. DISCOUNT CAP OVERRUN WAS console.warn ONLY (commit cd77c16).
   Honouring an over-cap discount is right — the customer was already charged
   the discounted total — but it left no queryable trace. Added nullable
   orders.discount_overrun_at (migration 0004, additive, no backfill), set in
   the same transaction as the paid transition. The warn stays for ops.

TESTING HAZARD HIT AGAIN, IN MY OWN TEST:
  The first version of the overrun test asserted `.not.toBeNull()`. undefined
  is not null, so it went GREEN against a column that did not exist — while
  the two weaker sibling tests failed. Only the sibling failures revealed it.
  Now asserts toBeInstanceOf(Date). Third instance of this family in this
  project. The rule that keeps catching it: assert the value you expect, never
  merely the absence of one.
  Same trap in the other direction: `toThrow(SomeClass)` matches ANY error
  when the class is undefined, so the product-unavailable tests initially
  passed off an unrelated FK violation. They now assert err.name too.

Verified: 256 tests / 19 files, tsc clean, lint clean, build 10 routes,
e2e 7/7 INCLUDING the real Stripe payment with stripe listen forwarding.

# Coldsmoke — US State Dropdown

Plan: docs/superpowers/plans/2026-09-25-us-state-dropdown.md
Spec: docs/superpowers/specs/2026-09-25-us-state-dropdown-design.md
Branch: feat/state-dropdown
Base commit: 2f86dc4
Started: 2026-09-25

## Pre-flight note
The plan deliberately duplicates the 4-line zod `state` field in both server
actions rather than sharing it, to keep `lib/addresses/states.ts` zod-free and
out of the client bundle. Reasoned in spec §4 and approved. Reviewers may flag
it as duplication; if they do, it goes to the human, not a silent fix.

## Progress
Task 1: complete (commits 2f86dc4..7548efa, review clean)
  - states.ts byte-for-byte with the plan block; 6/6 tests.
  - Reviewer hand-checked all 51 code/name pairs against USPS: all correct.
    (No test can catch a wrong code, so this was the real gate.)
  - No findings at any severity.
Task 2: complete (commits 7548efa..8492529, review clean)
  - Select.tsx + StateSelect.tsx, both byte-for-byte with the plan. tsc + lint clean.
  - No unit test by design (vitest is node env, no jsdom/testing-library);
    reviewer judged that reasoning sound.
  - Reviewer's WARNING item: could not verify from this diff that Tasks 3/4
    actually pass defaultValue/error into StateSelect. CONTROLLER TO CONFIRM
    in the Task 3 and Task 4 diffs.
  - Minor, deferred to final review:
    1. Native chevron colour tracks CSS `color` in Firefox but not
       Chromium/WebKit — cosmetic, and keeping the native chevron was the
       documented choice.
    2. StateSelect has no guard for a defaultValue outside US_STATES; it
       falls back to the disabled placeholder. Safe only because callers
       pass zod-validated codes.
Task 3: committed b76b560 (review in flight at time of writing)
  - Schema, CheckoutForm, unit tests, and BOTH e2e fill sites done.
  - Implementer reported DONE_WITH_CONCERNS: `npm test` is red on
    src/test/plan-drift.test.ts only. Correct and expected — reconciling is
    Task 5's job. Verified by the implementer via git stash that the tree was
    177/177 clean before Task 3.
  - PLAN ERROR FOUND BY IMPLEMENTER (good catch): Task 5's brief called the
    older-plan drift "Append-style subsequence" checks. They are actually full
    `Create` blocks compared byte for byte. Plan Task 5 Step 2 has been
    rewritten with the accurate file->plan mapping; brief must be regenerated
    before dispatching Task 5.
  - Drift now 4 files (the 4th, account/addresses/actions.ts, is Task 4's
    in-flight edit). Owning plans: 2026-09-19-coldsmoke-storefront-checkout
    (checkout actions.ts, CheckoutForm.tsx, e2e), 2026-09-20-customer-accounts
    (account actions.ts), and e2e is also declared in 2026-09-20-cart-quantity-stepper.
Task 3: complete (commits 8492529..b76b560, review Approved)
  - Reviewer independently re-verified the zod edge cases against zod 4.6.5
    (missing key, "", "mt", "XX") and the StateCode -> Address.state type flow.
  - Confirmed the `normalises a lowercase state` test survived UNEDITED, which
    is the evidence the swap did not change stored data.
  - Reviewer's one "Important" finding (report describes an unrelated admin
    task) is VOID: it read a STALE task-3-report.md left by an earlier plan's
    run in this shared workspace, before the implementer overwrote it. The
    real report is dated today with proper RED/GREEN evidence. Stale
    task-4/5-report.md removed to stop this recurring.
  - Resolved Task 2's open WARNING for checkout: StateSelect hardcodes
    name="state" and label="State"; CheckoutForm passes only `error`, and
    correctly no defaultValue (that form never re-seeded). Task 4 still to
    confirm for the address form.
  - Minor, deferred to final review: no unit test for a missing or empty
    `state` key at checkout (behaviour verified correct out-of-band).
Task 4: complete (commits b76b560..01758c9, review Approved, zero findings)
  - Reviewer traced both named risks through real code paths: the test mocks
    reach genuine Postgres writes (not a no-op mock), and the re-seed
    correctly reselects the chosen state after a rejected submit.
  - This CLOSES Task 2's open WARNING item for the address form.
  - Drift now 5 files; AddressForm.tsx added. Owning plan for both account
    files is 2026-09-20-customer-accounts.md.

Out-of-band user request (not from the plan): the native chevron sat hard
against the select's right edge, because `.input`'s padding was sized for a
text cursor. Added src/components/ui/Select.module.css with a single
`select.select { padding-right: 2.1rem }` rule and wired it into Select.tsx.
Element+class specificity is deliberate: `.input` sets `padding` as a
shorthand, so an equal-specificity class would win or lose on stylesheet
order. tsc + lint clean. This changes Select.tsx, so Task 5 must also
refresh THIS plan's Select.tsx block and add the new CSS file.
Task 5: complete (commits c4b142b, 966bfbd)
  - Drift guard 5 -> 0. Verified independently: Task 5's ONLY change under
    src/ is the single PLANS line. The Select.* changes in that commit range
    are the controller's chevron fix, not Task 5's.
  - Stale plans updated: 2026-09-19-storefront-checkout (checkout actions.ts,
    CheckoutForm.tsx, e2e), 2026-09-20-customer-accounts (account actions.ts
    + AddressForm.tsx -- the latter was missing from my mapping table, agent
    caught it), 2026-09-20-cart-quantity-stepper (e2e).
  - FULL VERIFICATION (controller-run): 562 tests / 47 files pass, tsc clean,
    lint clean, e2e 18 passed + 1 expected skip.

Chevron fix, round 2 (commit 8a5893e): the FIRST fix (01682b6) did not work.
It set padding-right and I "verified" it by asserting computed style 33.6px.
Chromium draws the native select arrow at a fixed inset and ignores padding,
so the property applied and nothing moved. Lesson: that was measuring a proxy,
not the reported symptom. Round 2 uses appearance:none + two gradients, and
was verified by screenshotting the rendered control. User confirmed fixed.
Side benefit: removes the Firefox/Chromium native-arrow colour difference
that Task 2's review flagged as Minor.

# Coldsmoke — Payment Reconciliation

Plan: docs/superpowers/plans/2026-09-25-payment-reconciliation.md
Spec: docs/superpowers/specs/2026-09-25-payment-reconciliation-design.md
Branch: fix/payment-reconciliation
Base commit: 4e680b5
Started: 2026-09-25

## Why
Order 1030: pi_3UJe42C4O5W0d4Lo3Vq1CSNv reports succeeded / amount_received
5100, but the order is still `pending`. No stripe listen was forwarding, and
the webhook is the ONLY path that marks an order paid or clears the cart.
The "cart still shows (2)" report was the symptom.

## Pre-flight note
Task 6 is operational, not code: it recovers order 1030 and sends a real
confirmation email. The plan gates it on explicit user go-ahead. DO NOT
dispatch it without asking.
GO-AHEAD GRANTED by the user in conversation on 2026-09-25 ("yes, go ahead on
1030 when you get there"). Conditional on getting there: run it only AFTER
Tasks 4 and 5 are complete and full verification is green. Recovery must go
through the real order page (plan Step 2), never a manual DB edit -- if it
needs a DB edit, the feature does not work and that is the finding.
Note EMAIL_FROM is still Resend's shared test sender (no verified domain), so
the confirmation email's deliverability to a real inbox is not guaranteed;
report what Resend actually returns rather than assuming it arrived.
USER ASKED TO BE PINGED when Task 5 comes back green (push notification, not
just a chat line). Send it on Task 5's full verification result -- green or
not: if the suite fails, they still want to know at that moment.
PR AUTHORISED by the user on 2026-09-25 ("open a PR when everything's green").
Order: Task 4 -> Task 5 -> final whole-branch review (most capable model, one
fix subagent for the whole findings list, incl. the deferred Minors collected
above) -> Task 6 (1030 recovery) -> PR. Task 6 goes BEFORE the PR on purpose:
recovering a real order through the real page is the strongest evidence the
feature works, and it belongs in the PR body. "Everything's green" means the
four verification commands, not just npm test.

## stripe listen forwarder (set up 2026-09-25 14:3x, before Task 5's e2e)
User: "don't count the skip as green, get stripe listen running."
Running: pid 3171, `stripe listen --events payment_intent.succeeded,
payment_intent.payment_failed,charge.refunded --forward-to
localhost:3000/api/stripe/webhook`. Event list = exactly the three cases in
webhook/route.ts.
- CLI 1.51 REQUIRES --events/--all-snapshot/--all-thin; the first attempt
  without them exited 1 immediately. A bare `stripe listen` no longer works.
- Verified the CLI's listen secret EQUALS .env STRIPE_WEBHOOK_SECRET (compared
  without printing either), so forwarded events pass signature verification.
  The e2e's own guard explicitly does NOT check this, so it was worth checking.
- Key passed via STRIPE_API_KEY in the env, not --api-key, to keep it out of
  `ps` -- which matters because the e2e skip guard reads `ps -ax -o args=`.
  Confirmed 0 processes hold the key value in argv.
- TESTING HAZARD, hit twice: `ps ... | grep 'stripe listen'` and
  `grep -c sk_test` both MATCH THEIR OWN COMMAND LINE. My first "2 listeners
  forwarding correctly / key leaked twice" readings were entirely self-matches.
  Correct method: snapshot ps to a FILE first, then grep the file (the grep
  runs after the snapshot, so it cannot appear in it); for a secret, pass the
  pattern via `grep -f patternfile` so the value never enters argv.
- Playwright reuses an existing :3000 server locally (reuseExistingServer:
  !CI). Port 3000 was free, so the e2e will start its own dev server.
  Do NOT leave a dev server up across a `next build` -- playwright.config.ts
  documents that combination serving pages whose Server Action POSTs no-op.
Stale reports from the previous plan's run deleted at start (shared workspace
reuses task-N-report.md names; a reviewer read a stale one last time).

## Progress
PLAN ERROR caught during Task 1 (controller): the plan declared
`Create src/lib/payments/fake.test.ts`, but that file ALREADY EXISTED with 8
tests (intent creation, PaymentIntentNotUpdatableError, succeededEvent
round-trip, refund idempotency x3). The implementer followed the brief and
overwrote them; caught in the working tree before any commit, originals safe
at HEAD. Implementer told to restore + append, and to confirm 13 tests.
Plan corrected: that block is now "Append to", not "Create" -- which also
keeps Task 5's drift check correct (subsequence, not byte-for-byte).
Verified the plan's three other Create files are genuinely new.
Task 1: complete (commits 4e680b5..b9c1de1, review Approved)
  - getIntentStatus on the port + stripe.ts (lazy getStripe, narrow catch:
    null ONLY for StripeInvalidRequestError, re-throw otherwise) + fake.ts,
    plus setIntentStatus test helper.
  - 13 tests (8 pre-existing recovered + 5 new). Controller verified by
    diffing test NAMES before/after: zero lost. Reviewer independently
    confirmed the diff's only hunk starts at line 170, after all 8 originals.
  - Minor, deferred to final review: (1) StripeInvalidRequestError covers
    both unknown and malformed ids -- matches Stripe's real behaviour, noted
    only if a later task must distinguish them; (2) new tests don't reuse the
    existing suite's beforeEach setup idiom.
Task 2: complete (commits 07d0e69..3bbfe60, review Approved)
  - completePaidOrder moved to src/lib/orders/completePaid.ts. Reviewer
    verified side-effect ORDER and catch/swallow semantics byte-identical,
    private copy fully deleted, imports exactly right (findOrderById,
    sendOrderConfirmation, clearCart removed; markOrderPaid still used at
    route.ts:34). Webhook tests 12/12 with the test file UNTOUCHED.
  - Two Important findings, both plan-mandated, ADJUDICATED by controller
    with evidence rather than escalated:
      * log tag [webhook] -> [payments]: KEPT. Verified nothing keys on it
        (no Sentry/Datadog/Logtail anywhere; deploy-failure.yml does not
        grep it). Tagging a reconciliation failure [webhook] would
        misattribute it.
      * doc comment expanded beyond "one sentence": KEPT, it explains why
        the module exists.
    Root cause was MY plan calling this a "pure move" while the brief
    changed four things. Plan text corrected to state the three prose
    changes and why.
  - Minor for final review: completePaid.ts imports findOrderById from
    "./index". Safe today (index.ts does not re-export completePaid), but
    would cycle if anyone barrels it. Task 3 must import completePaidOrder
    from @/lib/orders/completePaid directly, NOT via @/lib/orders.
  - Minor: dropped "only" from the webhook-authoritative comment. Correct
    once reconciliation exists.
Task 3: committed 652d3ee (review in flight at time of writing)
  - reconcilePendingOrder in src/lib/orders/reconcile.ts. Report at
    .superpowers/sdd/task-3-report.md; review package
    .superpowers/sdd/review-a8b885f..652d3ee.diff.
  - Re-dispatched once: the first attempt's helper was wrong. Resumed with the
    corrected helper, PLUS an explicit check that the no-double-email test
    actually pins the guarantee rather than passing vacuously. It does: the
    guarantee was mutation-tested (break markOrderPaid's ledger short-circuit
    -> the test fails), so the test is load-bearing, not decorative.
  - Controller commit 5a97fbd (plan text only): Task 6 Step 3's items_left
    query must SUM(ci.quantity), not COUNT rows -- counting rows would read 0
    only by accident for a 1-line order and would have "passed" while leaving
    a 2-item cart behind. Same class of bug as the symptom that started this.
  - Task 4 (order page wiring) dispatched in parallel: it consumes reconcile.ts
    but touches only page.tsx + e2e/checkout.spec.ts, so no file overlap.

BOTH PARALLEL AGENTS DIED SILENTLY (discovered ~9h later, 2026-09-25 23:27).
Neither the Task 3 reviewer nor the Task 4 implementer ever reported; Task 4
left page.tsx edited-but-uncommitted in the working tree for nine hours. A
long-running `stripe listen` started in the same window was also killed. Do not
assume a backgrounded agent here will survive; check for its artifacts
(report file / commits) rather than waiting on a notification.
User chose a HYBRID recovery: controller implements, agents review.
Task 3: complete (commits a8b885f..652d3ee + fix 653688f, Approved after 1 fix)
  - Review verdict on the original commit was NEEDS FIXES, two Importants, both
    in the test file. The implementation (reconcile.ts) needed no change.
  - MY EARLIER CLAIM WAS WRONG and is corrected here: I recorded that the
    no-double-email guarantee was mutation-tested and "exactly right". It was
    mutation-tested against ONE mutation (unconditional completePaidOrder) but
    NOT against a disabled short-circuit. Reviewer traced it: the test's
    webhook half left the order `paid`, so markOrderPaid returned null via the
    STATUS short-circuit (index.ts:341-343), not the ledger key. Delete those
    lines and markOrderPaid throws StrandedPaymentError, reconcile.ts:60
    swallows it, changed===false and sent===[] -- identical observations, test
    still GREEN. The same blind spot covered all four "leaves it alone" tests:
    reconcilePendingOrder swallows everything, so "returned false, changed
    nothing" is what a correct no-op AND an internal exception both look like.
  - Fix (653688f, test file only): spy console.error in beforeEach, restore in
    afterEach; the four no-op tests assert it was NOT called, the swallow test
    asserts it WAS. And the webhook half now runs BOTH phases (markOrderPaid
    then completePaidOrder) and asserts exactly ONE email across the
    interleaving -- before, `sent` was empty for the trivial reason that the
    email lives in completePaidOrder, so the test said "reconciliation sent
    none", not the spec's "exactly one in total".
  - Verified load-bearing by actually running the mutation: removing
    index.ts:341-343 now FAILS the test. index.ts restored, git diff empty.
  - Controller resolved both of the reviewer's ⚠️ items: (1) Task 4 does trust
    the boolean -- it re-reads only when reconciled is true -- so a throw in
    completePaidOrder after a successful markOrderPaid renders one stale
    "Awaiting payment"; the NEXT render reads `paid` from the DB and self-heals,
    so it is cosmetic and bounded. The lost confirmation email in that window is
    the real cost and is the reviewer's Minor 1, inherited from the webhook's
    identical two-phase hole. (2) The exactly-one-email end-to-end gap is what
    the fix above closes.
  - Minors for final review: (1) reconcile.ts:58 returns false after having
    transitioned the order, contradicting its own docstring, and the email is
    then lost permanently; (2) reconcile.ts:61 logs one message for a Stripe
    outage, OrderNotFoundForPaymentError and StrandedPaymentError alike --
    the latter two are money-without-an-order and the webhook deliberately
    surfaces them as non-2xx; (3) no `canceled` case in the status tests;
    (4) Postgres NOTICE noise makes test output non-pristine.
Task 4: complete (commits 5a97fbd..a55bf01, controller-implemented)
  - The dead agent's Step 1 edit was already correct and byte-equal to the
    plan's block, placed after the notFound() guard. Steps 2-5 were missing.
  - Controller finished: tsc + lint clean (this is the check that the `let`
    reassignment still satisfies OrderWithItems), added the e2e cart assertion,
    committed.
  - E2E RAN FOR REAL, NOT SKIPPED: 19 passed including "a guest can buy a
    bottle" (3.9s), with the forwarder delivering 1 real
    payment_intent.succeeded. That is the evidence the plan demanded; a skip
    would not have been.
  - OBSERVED IN THAT RUN, relevant to Task 6: the confirmation email FAILED
    with a Resend 422 -- it rejects buyer@example.com ("use our testing email
    address instead of domains like example.com"). The order still completed,
    which confirms completePaidOrder swallows email failures by design. For
    order 1030 the address is real, so this specific 422 should not recur --
    but EMAIL_FROM is still Resend's shared test sender, so do not claim
    delivery without reading what Resend returns.
  - npm test at this point: 569 passed, 6 failed, ALL SIX in plan-drift.test.ts.
    Expected -- that is precisely Task 5's job.
PLAN ERROR (Task 5's mapping table, found by controller): the table says
`src/app/(store)/order/[number]/page.tsx` "is not in any plan, so it needs
nothing." FALSE -- it has a full Create block at
2026-09-19-coldsmoke-storefront-checkout.md:6415 and it IS one of the six
failing cases. Drift is 6 files, not the predicted 5. Also note a grep trap
here: `order/[number]/page.tsx` in a BRE pattern makes [number] a character
class, so a naive `grep` finds nothing and appears to confirm the plan's claim.
Use grep -F.
PLAN ODDITY, not yet acted on: the plan puts Task 3's test at
`src/app/(store)/order/reconcile.test.ts` -- a route directory -- while the
module under test is `src/lib/orders/reconcile.ts`. Repo convention is
colocation (src/lib/orders/reuse.test.ts, src/lib/payments/fake.test.ts).
Functionally fine, vitest picks it up. Raised with the user rather than moved,
since moving it changes a registered plan block.
Task 3 re-review: APPROVED, both Importants closed. Reviewer independently
re-traced index.ts:341-346 against the catch at reconcile.ts:60-67 and confirmed
the mutation result, and confirmed the console.error spy cannot leak (recreated
per test) or mask (a stray error now FAILS the four silent tests).
  - Its 3 new Minors were fixed immediately (ad9bc1e) rather than deferred,
    because Minor 1 was a gap MY fix introduced: the spy was file-wide but only
    asserted in some tests, so the two success-path tests silently discarded
    errors they used to print. Also moved the getIntentStatus spy's restore into
    afterEach (a failed assertion could leave it rejecting for the rest of the
    file) and optional-chained both restores.
Task 5: complete (commit b1d5e0f)
  - Synced 6 stale Create blocks (not 5) in 2026-09-19-storefront-checkout, and
    re-synced this plan's reconcile.test.ts block TWICE, since the Task 3 fix
    and then the Minor fixes each changed the shipped file after the first sync.
    Sync done with a script (scratchpad/sync_drift.py) that mirrors the guard's
    parser and REFUSES to rewrite a `plan-drift: partial` block or an
    `Append to` block -- rewriting either would silently delete a documented
    exception or convert a subsequence check into a false byte-for-byte pass.
  - Guard 6 failures -> 0. 201 checks, up from 195: registering this plan added
    its own Create blocks (completePaid.ts, reconcile.ts, reconcile.test.ts).
  - FULL VERIFICATION, all four commands, controller-run:
    586 tests / 48 files pass; tsc clean; lint clean; e2e 19 passed.
    The payment e2e RAN (3.8s) with a live forwarder delivering 1 real
    payment_intent.succeeded -- not a skip.
Final whole-branch review dispatched (opus) with all 8 deferred items listed for
explicit triage. Item 2 (lost email if completePaidOrder throws after
markOrderPaid succeeded) flagged as the one most needing judgement.

Test file MOVED on user instruction (commit a2fa7c2), closing deferred item 8:
src/app/(store)/order/reconcile.test.ts -> src/lib/orders/reconcile.test.ts.
All 5 plan references rewritten, including the shell quoting that existed only
because the old path had parens and brackets. No relative imports to fix (the
file uses @/ aliases throughout). 586/48 unchanged after the move, so it is
still being collected; guard still 201, since the block content did not change
and the guard's "references no file that does not exist" case now sees the new
path. NOTE: this landed AFTER the final review's range (4e680b5..b1d5e0f), so
if that review cites the old path, that is why -- not a stale finding.
Final review verdict: READY TO MERGE WITH FIXES, zero Criticals. Fixes applied
in dabeb46: redirect after a successful reconcile (Important 1), completePaid.ts
comment corrected to say the side effects are NOT retried (Important 2),
distinct [reconcile][stranded-payment] tag (Important 3), 3s Stripe timeout on
the render path (Important 5), reconcileEventId docstring corrected (distinct
keys do NOT block each other -- the conditional update does), canceled test
added, spec §7 now names the cancelled-order gap.
Reviewer's Known-Item triage worth keeping: item 1 (barrel cycle) is a non-issue
-- findOrderById is DEFINED in index.ts, so there is nowhere cleaner to import
it from. Item 2's premise was wrong: completePaidOrder cannot throw (whole body
in try/catch, and sendOrderConfirmation swallows its own errors), so the
docstring contradiction was theoretical; the REAL risk is that the side effects
are unretryable once the status flips. Open follow-up: a completedAt column is
the only thing that would make "recoverable" true.

Task 6: order 1030 RECOVERED (2026-09-27 01:29:30 UTC), through the real page,
no DB edit. status paid, paid_at set, items_left 0, reconcile:pi_3UJe42... row
present. Two findings came out of doing it for real:
  1. THE REDIRECT FIX IS INCOMPLETE. On the client-side navigation that did the
     reconciliation (/order-lookup -> server action redirect -> /order/1030),
     the header still read "Cart (2)" beside "CONFIRMED". The App Router reuses
     the cached layout for the same route segment, so redirect() does not make
     the layout re-render. A subsequent full load reads "Cart" correctly, and a
     full page load that triggers reconciliation should be fixed by the redirect
     (HTTP-level second request) -- but that last part is REASONED, NOT
     VERIFIED, and cannot be verified on 1030 again because reconciliation is
     once-per-order. Server state was correct throughout; this is a client
     cache artifact, not a data bug.
  2. THE CONFIRMATION EMAIL WAS NOT SENT. Resend rejected it: "You can only send
     testing emails to your own email address (bayou.city.labs.hou@gmail.com)."
     So the customer-visible half of the recovery did not happen. This is the
     EMAIL_FROM stopgap, and it is the reviewer's "dropped email is the likely
     failure, not the exotic one" landing on the very first real use.
BADGE FIX COMPLETED AND VERIFIED IN A BROWSER (commit 6aac758). User chose to
fix rather than defer. RefreshAfterReconcile.tsx calls router.refresh() once
then strips the ?reconciled=1 marker via replaceState. Verified BOTH paths
against seeded pending orders backed by real test-mode intents:
  - client navigation (/order-lookup -> order page): was "Confirmed" + "CART (2)",
    now "Confirmed" + "CART". This is the path 1030 took and the one that failed.
  - cold load: correct with the redirect alone, as reasoned -- now actually
    observed rather than assumed.
Seeding method worth reusing: create a real test-mode PI (confirm with
pm_card_visa for succeeded, or leave unconfirmed to grant the access cookie
first and reconcile later on a genuine cold load), insert a pending order, and
POINT IT AT THE BROWSER'S OWN CART. That last part is the trap -- an order
pointing at its own seeded cart reproduces nothing, because the badge counts
the browser's cart, so clearing a different cart leaves the badge untouched.
TEST ARTIFACTS CLEANED UP at the user's request: orders 1034/1035
(badge-test@example.com), their two reconcile: ledger rows, and the three
orphan seed carts are gone. Deliberately NOT deleted: cart 9db1311e (order 1030
points at it too -- the delete was guarded on the cart being unreferenced
precisely so this could not be taken out), order 1030's real ledger row, and
the e2e-created orders/carts, which appeared mid-cleanup from the last
test:e2e run and are not mine to remove. Verified afterwards: 1030 still paid,
items_left 0.
Also observed: e2e order 1033 has BOTH an evt_ row and a reconcile: row, so
reconciliation DOES fire during e2e and reaches markOrderPaid -- it just usually
loses the race. That corrects the final review's claim that reconciliation never
fires in e2e, and is a concrete instance of the reconcile:-rows-overcount minor.

Task 6 BEFORE state confirmed (read-only): order 1030 pending, paid_at null,
items_left 2, zero reconcile: ledger rows. Email on the order is gesg@emak.com
-- not example.com, so the Resend 422 seen in the e2e will not recur for this
one, but the domain looks throwaway and EMAIL_FROM is still Resend's shared
test sender, so read what Resend returns rather than assuming delivery.

# ============================================================
# PLAN: Refund Restock (2026-09-27)
# Plan: docs/superpowers/plans/2026-09-27-refund-restock.md
# Spec: docs/superpowers/specs/2026-09-27-refund-restock-design.md
# Branch: TBD (set at Task 1)
# Base commit: recorded below
# ============================================================

## Pre-flight review (controller, before Task 1)
Found and fixed THREE defects in my own plan before dispatching anything:
1. StockPanel used `formAction={writeOffAction}` on a button inside the restock
   form. useActionState actions take (prevState, formData), so React would have
   passed FormData as prevState and nothing as formData -- it would have crashed
   on the first write-off. Restructured into two forms, matching ResendPrompt in
   FulfillForm.tsx.
2. writeOffOrderStock took adminUserId and never used it. Nothing records who
   decided (stock_decision_at stores only that a decision happened), so the
   parameter went nowhere. Dropped it.
3. The restock form's JSX indentation was stale after the fragment wrapper was
   added. That block is a byte-for-byte `Create` block, so the formatter would
   have rewritten it and failed the drift guard in Task 6.

Earlier self-review (before commit) had already fixed: requireAdminUser called
twice in restockAction; the restock.test.ts Create block missing the
vi.mock("@/lib/db/client") that the plan's own prose requires (without it the
suite writes to the DEV database); and an action-test fragment written with
`Create `path`:` syntax, which the drift parser compares byte-for-byte against a
whole file.

## Spec amendment made during planning
inventory_adjustments already exists, is migrated, and has ZERO writers, readers
and rows. The spec originally rejected "a ledger table" as too much machinery --
wrong, since one was already there. Restock now writes to it (delta,
reason="refund_restock", admin_user_id). restocked_quantity remains the GUARD;
the ledger is history and is never read to authorise a restock.

## Progress
Task 1: complete (commits 290068a..27bb9c6, review Approved, zero findings)
  - Two columns added: order_items.restocked_quantity (int, not null,
    default 0) and orders.stock_decision_at (timestamptz, nullable). Both
    verified present in the dev DB by the controller, not just claimed.
  - Implementer read the generated migration before applying it, as the brief's
    gate required, and reports exactly two ADD COLUMN statements.
  - SECOND COMMIT WAS NOT IN THE TASK'S FILE LIST, and is correct: schema.ts is
    a registered byte-for-byte Create block in
    2026-09-19-coldsmoke-storefront-checkout.md, so adding columns turned the
    suite red until that block was re-synced. +13 lines, that plan file only.
    Controller verified the stat before accepting. This is the same drift-sync
    work Task 6 does for this plan -- it just arrived early because schema.ts
    belongs to an OLDER plan.
  - 588/588 tests, 48 files. Reviewer's one WARNING was that it could not see
    test output from the diff; CONTROLLER RESOLVED IT by re-running the suite
    directly: 588/588, 48 files. The only stderr line is a pre-existing vitest
    config-loader notice, not from this change.
  - Reviewer independently verified the drift sync was byte-faithful by
    comparing hunk-for-hunk against the schema.ts hunk (both +9 and +4, same
    indentation and context) and confirmed no unrelated prose moved. Also
    confirmed via 0008_snapshot.json that no extra index or check constraint
    was smuggled in -- the restocked_quantity <= quantity bound is correctly
    still absent, since it belongs in Task 2's UPDATE, not in the schema.

## Standing instructions from the user (2026-09-27)
- "keep going through the rest of the tasks" -- run Tasks 1-6 continuously, no
  check-ins between tasks. Only stop for a BLOCKED status that cannot be
  resolved, or a finding that contradicts the plan (that is the human's call).
- "ping me when it's all done" -- send a PUSH NOTIFICATION at the END of the
  whole run, not per task. Send it whether the run ends green or stuck: if
  something blocks partway, they still want to know at that moment rather than
  discovering silence later.
- Branch feat/refund-restock, base e11b037. All six briefs pre-generated.
- Do NOT dispatch implementers in parallel; they collide in the same files.
- Verify each task by its ARTIFACTS (commit + report file), not by trusting a
  completion notification -- two agents died silently earlier today.
Task 2: complete (commits 5c21f4d..c421095, review Approved, 0 Critical/Important)
  - restockOrderItems + RestockNotAllowedError in src/lib/inventory/index.ts.
    inventory.test.ts 12 -> 21 tests. Full suite 597/597, tsc + lint clean.
  - MUTATION RE-RUN BY THE CONTROLLER, not just reported: deleting the
    `restocked_quantity + n <= quantity` line from the WHERE clause fails
    exactly "never returns more units than were ordered" and "returns the
    units once when the same restock is submitted twice" (2 failed / 19
    passed). index.ts restored, git diff empty. The bound is demonstrably
    load-bearing rather than decorative.
  - Controller also diffed pre/post test NAMES: zero pre-existing tests lost,
    which is the failure mode the brief warned about for an append.
  - Second commit is another older-plan drift sync (index.ts and
    inventory.test.ts are byte-for-byte Create blocks in
    2026-09-19-coldsmoke-storefront-checkout.md). Same pattern as Task 1.
    This keeps happening because this feature touches files described by an
    older plan; it is expected work, not the implementer freelancing.
  - Reviewer verified things worth keeping: the tx contract is TYPE-enforced
    (Tx resolves to PgTransaction which has rollback(): never, Db does not, so
    restockOrderItems(db, ...) will not compile) -- a caller cannot silently
    get partial restocks. Duplicate orderItemIds in one call accumulate
    CORRECTLY, because the second UPDATE sees the first's uncommitted
    increment; same per-statement re-evaluation that makes double-submit safe.
    Refusal-ordering staleness is not exploitable: inventoryState `committed`
    is terminal, and refundedCents is monotonic (written only via Math.max).
  - MINORS DEFERRED TO THE FINAL WHOLE-BRANCH REVIEW:
    1. index.ts:258-263 -- the inventory UPDATE does not check rows touched,
       unlike the claim above it. Unreachable today (reviewer traced FK and
       reserveStock paths), and commitStock/releaseStock share the gap, so it
       is pre-existing pattern rather than regression.
    2. index.ts:205 -- filter(quantity > 0) silently DROPS negative and
       non-integer quantities instead of refusing them. Task 4's parseLines
       rejects them, so this is defence-in-depth on an exported primitive.
    3. inventory.test.ts:447-462 -- "leaves reserved untouched" cannot tell
       "untouched" from "clamped to zero": the fixture starts at reserved 0.
       Seeding a non-zero reserved would make it discriminate.
    4. NO MULTI-LINE TEST anywhere, so the partial-rollback promise in the doc
       comment (line 1 restocked, line 2 refused -> both roll back) is never
       actually executed. Brief-prescribed gap, not implementer error.
    5. Duplicated stock() helper shadowing the module-level one.
    6. "refund_restock" is a free-text reason with no shared constant; a later
       admin-adjustment feature could spell a sibling inconsistently.
  - POLICY NOTE FOR THE USER (plan-mandated, not a bug): the gate is
    refundedCents > 0 with no proportionality, so a $1 partial refund on a
    two-bottle order unlocks restocking BOTH bottles. Mitigated by the admin
    choosing the quantities, and it is what the plan's global constraint
    specifies -- but it is a policy choice the human may want to revisit.
Task 3: committed d68016a (review in flight at time of writing)
  - restockRefundedOrder + writeOffOrderStock + awaitsStockDecision in
    src/lib/orders/restock.ts. 6/6 tests, full suite 603/603, tsc + lint clean.
  - No drift-sync commit needed this time: both files are Create blocks in
    THIS plan, which Task 6 registers with the guard.
  - PLAN BUG FOUND BY THE IMPLEMENTER (good catch): the Interfaces summary line
    still advertised writeOffOrderStock(args: { orderId, adminUserId }) after
    my pre-flight fix removed that parameter from the code block. The
    implementer followed the verbatim code and the explicit "do not add a
    parameter that goes nowhere" instruction, then flagged the contradiction
    instead of silently picking one. Plan line corrected by the controller.
    Root cause was mine: I edited the code block during pre-flight and did not
    re-read the Interfaces block above it.
Task 3: complete (commits dfbbf2b..d68016a + guard fix, review Approved)
  - Reviewer verified atomicity against REAL Postgres semantics rather than
    assuming: client.ts:11-13 documents using postgres-js over the Neon HTTP
    driver precisely because inventory needs real multi-statement transactions,
    so db.transaction's rollback-on-throw is genuine BEGIN/ROLLBACK. That is
    what makes "records no decision when the restock is rejected" a real test.
  - Reviewer confirmed the db-client mock applies (vi.mock + dynamic import,
    no static import leak). Worth noting because the failure mode is invisible:
    tests would still PASS while writing to the DEV database.
  - CONTROLLER RESOLVED THE REVIEW'S ONE WARNING, and it was a real hole:
    writeOffOrderStock had no guard, so an out-of-band caller could stamp
    stockDecisionAt on an order that was never refunded. Harmless today
    (awaitsStockDecision is already false for it), but poisonous later --
    refund that order afterwards and it would NEVER appear as awaiting a
    decision. Added refusals for "no such order" and "no refund recorded",
    plus a test, and mutation-verified: removing the guard fails that test.
  - This plan's restock.ts and restock.test.ts Create blocks re-synced after
    the fix, so Task 6's registration will not immediately fail on them.
Task 4: complete (commits bf8043e..4be229f, Approved after 1 fix pass)
  - restockAction + writeOffAction + parseLines + StockState appended to
    src/app/(admin)/admin/orders/[id]/actions.ts. 4/4 focused, 608/608 full
    suite, tsc + lint clean.
  - Controller verified by HASHING each pre-existing action before and after:
    fulfillAction, resendShippingAction and refundAction are byte-identical.
    That is the real risk of an append, and it is checked rather than assumed.
  - Controller-ordered deviation from the brief, and it was necessary:
    writeOffAction needed a try/catch because Task 3's guard fix made
    writeOffOrderStock throw. The brief predates that fix, so following it
    verbatim would have let a refusal escape as an unhandled Server Action
    rejection. Verified present in the shipped code.
  - THIRD drift-sync commit of the run (2026-09-20-admin-orders.md this time).
    Every task so far has touched a file that an older plan describes with a
    byte-for-byte Create block. This is expected and correct; the alternative
    is plans that lie about the shipped code.
  - FIRST "Needs fixes" of the run, and it was earned. Three Importants:
    1. parseLines accepted a BLANK field as a valid zero. Number("") is 0 and
       Number.isInteger(0) is true, so malformed input passed as a legitimate
       zero-unit line -- while the comment beside it claimed it refused exactly
       that. Fixed by trimming and returning null before Number() is reached.
       Reviewer confirmed no legitimate input changed meaning: Number() already
       ignored surrounding whitespace, so " 2" parsed to 2 before and still does.
    2 & 3 WERE MY DEFECTS, not the implementer's -- both test bodies came
       verbatim from my brief:
       * No test would have failed if the deliberate
         `instanceof RestockNotAllowedError` discrimination were replaced with a
         blanket catch-all. That rethrow exists so a genuine bug surfaces rather
         than being flattened into a friendly message an admin reads as normal.
       * The write-off test asserted only that onHand stayed 10 -- equally true
         if the action did nothing at all. Same vacuous-test class as the
         no-double-email test earlier today, and from the same cause: asserting
         the absence of a change without asserting the change that SHOULD occur.
    Both fixes were demonstrated load-bearing, not asserted: catch-all
    replacement failed the new rethrow tests (5/7), no-op stub failed the
    strengthened write-off test (6/7), restores gave 7/7.
  - Tests 4 -> 7. fulfillAction/refundAction still hash-identical after the fix.
  - LESSON WORTH CARRYING: my briefs keep specifying tests that assert a status
    or an absence rather than a distinguishing effect. Task 5 and 6 briefs
    should be read with that in mind.
Task 5: complete (commits 937b2e7..23c3473, review Approved, 0 Critical/Important)
  - StockPanel.tsx + detail page wiring + list marker. tsc/lint clean, 611/611.
  - CONTROLLER DID THE BROWSER CHECK the implementer was told to skip (it
    cannot establish an admin session). The Chrome extension timed out on
    screenshots three times, so I switched to a THROWAWAY Playwright spec
    following admin.spec.ts's pattern (sign up, force emailVerified + role
    admin in the DB, sign in). Verified against a real refunded order: list
    marker present, input defaults to full ordered quantity, Return to stock
    moved on_hand by exactly 2 and set stock_decision_at, marker then gone.
  - THAT CHECK CAUGHT A DEFECT NO CODE REVIEW WOULD HAVE: the panel worked but
    rendered as an unstyled block with colliding columns, directly beneath a
    properly formatted Items table. MY plan omitted the CSS classes. Fixed by
    reusing detail.module.css (styles.table/right/subheading) rather than
    inventing styles; reviewer independently confirmed the Items table above
    already right-aligns numeric columns the same way.
  - Cleanup after verification: throwaway spec deleted, check orders and
    panel-check admin users removed, and on_hand corrected back to 33 -- the
    two runs restocked orders whose stock was never actually deducted, so they
    had invented 4 units.
Task 6: complete (controller-run, commit below)
  - Registering this plan immediately caught TWO stale blocks, which is exactly
    what the guard is for: the plan's parseLines predated Task 4's
    blank-quantity fix, and its writeOffAction predated the try/catch I ordered
    when Task 3's guard made writeOffOrderStock throw. Both synced to shipped.
  - Guard 211 checks green with this plan registered.
  - FULL VERIFICATION, all four commands:
    620 tests / 50 files pass; tsc clean; lint clean; e2e 19 passed.
    The payment e2e RAN (4.4s) with a live forwarder delivering 1 real
    payment_intent.succeeded -- not a skip.

## Standing instruction added 2026-09-27
- "open a PR when the review comes back" -- PR AUTHORISED for
  feat/refund-restock, but only AFTER the final whole-branch review returns and
  its Critical/Important findings are resolved. Dispatch ONE fix subagent with
  the complete findings list if there are any; do not open one fixer per
  finding.
- Still owed: the end-of-run PUSH NOTIFICATION ("ping me when it's all done").
  Send it once the PR is open, or immediately if the run ends stuck instead.
- Base for the final review: e11b037. Branch has 24 commits, tree clean, all
  four verification commands green.
