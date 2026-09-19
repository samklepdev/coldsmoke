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
