# Coldsmoke

Storefront and marketing site for Coldsmoke, a cool-spice-and-smoke cologne.

Next.js (App Router) · Postgres + Drizzle · Stripe Elements · Resend

## Setup

```bash
npm install
cp .env.example .env    # fill in real values
docker compose up -d    # local Postgres on port 54328
npm run db:migrate
npm run db:seed
npm run dev
```

## Architecture

Store logic lives in `src/lib/` modules with explicit interfaces. Pages and
Server Actions are thin callers.

- `lib/pricing/quote.ts` is the **only** place money is computed. The cart, the
  PaymentIntent, and the webhook all call it, so they cannot disagree.
- `lib/payments/` is the **only** place that imports the Stripe SDK. Tests use
  `FakePayments` instead.
- `lib/inventory/` guards stock in SQL WHERE clauses, so Postgres decides races
  between concurrent buyers.
- The Stripe webhook is the only writer of order status `paid`, and is
  idempotent via the `stripe_events` ledger.

All money is integer cents. `formatCents` is for display only.

Two cookie rules worth knowing before editing page code:

- Server Components may not write cookies. Pages and layouts call `getCartId()`
  (read-only); only Server Actions call `getOrCreateCartId()`.
- A `"use server"` module may export only async functions, so cookie names live
  in `src/lib/cookies.ts` rather than beside the actions that use them.

### Order page access

`/order/[number]` takes no credential in the URL. Access comes from an
httpOnly cookie holding **order ids** — `orders.id` is a v4 UUID, so the
cookie value is itself the unguessable credential. A cookie naming the
customer-facing number (`CS-1000`) would be trivially forgeable: httpOnly
stops page scripts from reading it, but nothing stops a hand-written request
from sending whatever it likes.

Checkout and `/order-lookup` both grant access; the grant is applied as an
`inArray` in the SQL `WHERE` clause (`findOrderByNumberForIds`), so no code
path reads an order without one. A missing credential returns 404 rather than
redirecting to the lookup form, because a distinguishable response would
confirm which order numbers exist.

## Testing

```bash
npm run db:test:up      # throwaway Postgres on port 54329
npm test                # unit + integration
npm run test:e2e        # Playwright smoke test
npm run db:test:down
```

`npm test` includes `src/test/plan-drift.test.ts`, which asserts that every
code block in the implementation plan matches the file it claims to create.
Plan 1 accumulated a dozen review fixes that were applied to the source and
silently not to the plan, so re-running it would have reproduced defects that
had already been found and fixed. **If that test fails, update the plan's code
block to match the source — do not weaken the test.**

A block may be marked with an HTML comment when it is deliberately an
intermediate state (one file is created in Task 12 and appended to in Task
13). Those are held to a weaker rule — their code must still appear verbatim
in the shipped file — and the test caps how many may exist.

The dev and test databases are separate Compose projects on separate ports and
volumes. Starting one does not touch the other.

`npm run test:e2e` runs five tests, the last of which pays with a real Stripe
test card and waits for the confirmation page to reach "Confirmed" — so it
only passes while `stripe listen` is forwarding. It skips itself when
`STRIPE_SECRET_KEY` is missing or a placeholder.

## Webhooks in development

```bash
stripe listen \
  --events payment_intent.succeeded,payment_intent.payment_failed,charge.refunded \
  --forward-to localhost:3000/api/stripe/webhook
```

Put the printed `whsec_...` in `.env` as `STRIPE_WEBHOOK_SECRET`.

The `--events` flag is required: as of Stripe CLI 1.51 a bare
`stripe listen --forward-to ...` exits with *"must specify events to forward
using --events, --all-snapshot, or --all-thin"*. The three listed above are
the ones `/api/stripe/webhook` acts on.

`stripe listen` needs credentials. Either run `stripe login` once, or pass the
key already in `.env` without an interactive login:

```bash
set -a && . ./.env && set +a
STRIPE_API_KEY="$STRIPE_SECRET_KEY" stripe listen --events ... --forward-to ...
```

## Current state

Plan 1 is implemented and verified end to end against real Stripe: a test card
pays, the webhook marks the order paid, stock commits, the cart clears, and a
replayed event changes nothing. Four things are still worth knowing.

- **Checkout requires Stripe Tax to be active.** `createPendingOrder` calls
  `calculateTax` and deliberately blocks if it fails — charging a guessed tax
  amount is worse than asking the customer to retry. If Stripe Tax is not
  activated, every checkout returns "We couldn't start checkout." Check with:

  ```bash
  stripe tax settings retrieve      # status must be "active", not "pending"
  ```

  A fresh account reports `status: pending` with
  `missing_fields: ["head_office"]`; set the origin address under
  Dashboard → Settings → Tax. This is an account setting, not a code change.
- **No sales tax is currently collected.** The account has an origin address
  but **zero tax registrations**, so `calculateTax` returns 0 for every
  destination. That is correct behaviour — Stripe only charges where you are
  registered — but it means orders collect nothing today. Add registrations
  under Dashboard → Tax → Registrations before going live.
- **`/the-scent` and `/about` are linked but do not exist.** Both appear in the
  site header, and `/the-scent` in the home hero. They 404 today; the pages
  come with Plan 4.
- **`npm audit` reports 4 moderate vulnerabilities, knowingly accepted.** All
  four are [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)
  — esbuild's *dev server* accepting cross-origin requests — reaching us
  transitively via `drizzle-kit`, a devDependency used only by
  `npm run db:generate`. Nothing in this project starts an esbuild dev server,
  and the advisory never touches a deployed artifact. `npm audit fix --force`
  resolves it by installing `drizzle-kit@0.18.1`, a downgrade across 13 minor
  versions that would break the current config format. Re-evaluate when
  `drizzle-kit` ships a fix that moves forward rather than back.

## Deployment

Vercel + Neon. Set every variable from `.env.example` in the project settings,
add the production webhook endpoint in the Stripe dashboard pointing at
`/api/stripe/webhook`, and set `CRON_SECRET` to match the cron configured in
`vercel.json`. The cron route refuses to run if `CRON_SECRET` is unset.

## Plans

- Plan 1 (this) — storefront and guest checkout
- Plan 2 — customer accounts (Better Auth)
- Plan 3 — admin panel
- Plan 4 — marketing pages and brand polish

See `docs/superpowers/specs/` and `docs/superpowers/plans/`.
