# Railway Reservation-Release Cron — Design

**Date:** 2026-09-23
**Status:** Approved design, pending implementation plan

Run `releaseExpiredReservations` on a schedule under Railway, as a separate cron
service that talks to Postgres directly.

---

## 1. Why

**Nothing currently releases expired reservations in production.** The only schedule
for `/api/cron/release-reservations` is declared in `vercel.json`:

```json
{ "crons": [{ "path": "/api/cron/release-reservations", "schedule": "*/5 * * * *" }] }
```

Coldsmoke deploys to Railway, which ignores that file entirely. The route exists, is
authenticated, and is tested — and has never once been called. Every abandoned checkout
that reserved stock holds it forever: `orders.inventoryState` stays `reserved`,
`releaseStock` is never reached, and the reserved count that `available` subtracts from
`onHand` only ever grows. The store silently sells less than it has, and the first
symptom is a product that reports out of stock while sitting in a box.

This is a deployment gap, not a logic bug. `releaseExpiredReservations`
(`src/lib/inventory/index.ts:135`) is correct and covered. It is simply never invoked.

---

## 2. Scope

### In scope

- A CLI entrypoint that runs the sweep once and exits.
- An npm script for it.
- Moving `tsx` to `dependencies` so the script can run on Railway.
- Deleting `vercel.json`.
- Written Railway dashboard steps, since the project cannot be configured from here.

### Out of scope

- **The `/api/cron/release-reservations` route.** Kept unchanged as a manual ops
  trigger. It is the only way to force a sweep without a deploy, and it is already
  tested. It is no longer the scheduled path.
- **Releasing reservations lazily on read.** Folding the sweep into the availability
  query would suit a sleeping app and need no scheduler at all, but it puts writes on a
  hot read path and changes behaviour well beyond scheduling. Considered and rejected
  for this change; still open as a future simplification.
- **An in-process `setInterval` via `instrumentation.ts`.** Ruled out by serverless —
  see §3.
- **Scheduling anything else.** No other job exists yet.

---

## 3. Architecture

### Why a separate service, and why not HTTP

The web service runs with Railway's serverless (app-sleeping) mode on. Two documented
Railway behaviours decide this design between them:

> A service is woken when it receives traffic from the internet or from another service
> in the same project through the private network.

> Once a service stops sending packets it is considered inactive after 5 minutes.

A 5-minute cron that reaches the app over HTTP — public URL or private network, it
makes no difference — wakes it before it can ever go idle. The web service would never
sleep again, which removes the entire reason serverless is enabled. The same argument
rules out an external scheduler pointed at the public URL.

So the job connects to Postgres itself and never addresses the web service at all. The
web service sleeps undisturbed; only the cron container and the database wake.

An in-process `setInterval` fails for the mirror-image reason: while the app is asleep
no timer fires, so reservations would sit until the next customer happened to arrive —
precisely when accurate stock matters most.

| Unit | Responsibility |
|---|---|
| `lib/inventory/releaseJob.ts` (new) | Runs the sweep once, logs the count, exits. Owns no logic. |
| `releaseExpiredReservations` | Unchanged. Already takes an optional `Db` and is covered by `inventory.test.ts:238`. |
| `api/cron/release-reservations` | Unchanged. Manual trigger only. |
| Railway cron service | Owns the schedule. No application code. |

### The entrypoint

Modelled on `src/lib/db/promote-admin.ts`, which already solves this exact shape:

```ts
main()
  .catch((error) => {
    console.error("[release-reservations] failed", error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
```

**`process.exit()` in `finally` is load-bearing, not stylistic.** Railway requires a
cron container to "terminate as soon as that task is finished, leaving no open
resources", and skips the next tick if the previous run is still alive. postgres.js
holds the event loop open with its pool, so a job that merely returns from `main()`
never exits — Railway would then skip every subsequent tick. The cron would run exactly
once, report success, and go quiet, with a green dashboard the whole time. That failure
is invisible, which is why the exit is specified here rather than left to convention.

(`db.$client.end()` would also work — drizzle 0.45 exposes the postgres.js client — but
`process.exit()` matches the existing entrypoints and cannot be defeated by a stray
handle somewhere else in the import graph.)

`import "dotenv/config"` comes first, as in every other entrypoint, so the job runs
locally against `.env`. dotenv does not overwrite variables already present, so
Railway's injected `DATABASE_URL` still wins in production.

### Why `tsx` moves to `dependencies`

Railway builds with `NODE_ENV=production` — the deploy log carries npm's
`warn config production Use --omit=dev instead` — so devDependencies are not installed
and `tsx` would not exist on the cron service. Moving it costs roughly 30 MB in the image and also
unblocks `db:migrate`, `db:seed`, and `db:promote-admin` — all of which are production
operations today that cannot currently run on Railway for the same reason.

---

## 4. Railway configuration

A second service in the existing project, deploying from this repository.

| Setting | Value |
|---|---|
| Cron Schedule | `*/5 * * * *` |
| Start Command | `npm run cron:release-reservations` |
| Variables | `DATABASE_URL` — reference the same Postgres service |

Five minutes is Railway's documented floor; more frequent schedules are not supported,
and it matches the cadence `vercel.json` intended.

**Build command:** leave it at Railway's default. The cron service will then run
`npm run build` and produce a Next.js build it never serves — roughly 35 s of waste per
deploy, and nothing more. Overriding it to skip the build is a valid optimisation, but
it is a divergence between two services built from one repo, and the cost it saves is
trivial. Default unless deploys become slow enough to care.

`CRON_SECRET` is deliberately **not** set on this service. It authenticates the HTTP
route, and this job does not use it. Holding the database credentials is the
authorisation, as with `db:promote-admin`.

---

## 5. Failure modes

| Case | Behaviour |
|---|---|
| Job throws | Non-zero exit; Railway records a failed run and logs the error. Next tick retries. Sweeps are independent, so a missed run self-heals. |
| Job overruns 5 minutes | Railway skips the next tick rather than overlapping. Cold boot counts against that budget. Acceptable at current volume; worth watching, because skips are silent. |
| Two runs somehow overlap | Safe. Each order is handled in its own transaction and the update is guarded by `eq(orders.status, "pending")`, so a second run matches zero rows. Already proven by the concurrency test at `inventory.test.ts:282`. |
| Database unreachable | Job exits non-zero without touching state. |
| Web service asleep | Irrelevant. The job never contacts it. |

---

## 6. Testing

No new automated test. The entrypoint is a `main()` wrapper over a function with
existing integration coverage, and the part that could genuinely break — that the
process exits — is not observable from inside the process.

Verification is:

1. `npm run cron:release-reservations` against the dev database returns a count and the
   **shell prompt comes back**. A hung prompt is the failure this job is most likely to
   ship with.
2. `npm test`, `npm run lint`, and `npm run build` stay green.
3. After deploy, one manual Railway run showing a zero exit code.

---

## 7. Plan drift

`src/test/plan-drift.test.ts` guards only the plans named in its `PLANS` list
(`:23`), and it says so explicitly: a plan left off that list is unguarded, and the
omission is silent because the suite stays green either way. The implementation plan for
this work must be added to that list in the same commit that lands it.

---

## 8. Success criteria

- Expired reservations are released in production without a customer request.
- The web service still sleeps — enabling the cron does not keep it awake.
- The cron container exits on every run; no run is skipped for overrun.
- `vercel.json` is gone, so no schedule is declared that nothing honours.
- `npm test`, `lint`, and `build` green, with the plan in sync.
