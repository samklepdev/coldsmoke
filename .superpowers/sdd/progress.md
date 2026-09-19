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
