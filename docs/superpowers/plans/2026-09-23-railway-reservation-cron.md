# Railway Reservation-Release Cron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `releaseExpiredReservations` every five minutes on Railway, so abandoned checkouts stop holding stock forever.

**Architecture:** A CLI entrypoint runs the existing sweep once and exits. A separate Railway service owns the schedule and runs that entrypoint against Postgres directly — never over HTTP, which avoids a shared secret and a network hop, and stays correct if serverless is ever enabled on the storefront. `vercel.json`, which declared a schedule nothing honoured, is deleted.

**Tech Stack:** TypeScript, tsx, drizzle-orm + postgres.js, Railway cron services.

Design: `docs/superpowers/specs/2026-09-23-railway-reservation-cron-design.md`

## Global Constraints

- Cron cadence is `*/5 * * * *`. Five minutes is Railway's documented floor; shorter is not supported.
- The job must never make an HTTP request to the web service, by public URL or private network. Railway wakes a *sleeping* service on traffic from either. Serverless is off on the storefront as of 2026-09-23, so this is currently a forward-looking constraint rather than an active one — but an HTTP cron would silently become a permanent-wake bug the day serverless is switched on, so the rule stands.
- The job process must exit. Railway skips the next tick while a run is still alive.
- `CRON_SECRET` is not used by the job. It authenticates the HTTP route only.
- The `/api/cron/release-reservations` route is unchanged and stays as a manual ops trigger.

---

### Task 1: The cron entrypoint

**Files:**
- Create: `src/lib/inventory/releaseJob.ts`
- Modify: `package.json` (add script; move `tsx` to `dependencies`)
- Modify: `src/test/plan-drift.test.ts:23-26` (register this plan)

**Interfaces:**
- Consumes: `releaseExpiredReservations(database?: Db): Promise<number>` from `src/lib/inventory/index.ts:135`. Returns the number of orders cancelled.
- Produces: the npm script `cron:release-reservations`, which Task 3 configures Railway to run.

- [ ] **Step 1: Write the entrypoint**

Create `src/lib/inventory/releaseJob.ts`:

```ts
import "dotenv/config";
import { releaseExpiredReservations } from "./index";

/**
 * Releases stock held by abandoned checkouts, and cancels the orders holding it.
 *
 * Run by a Railway cron service every five minutes. It queries Postgres
 * directly rather than calling /api/cron/release-reservations: no shared
 * secret to keep in step, no network hop, and no way to fail as a silent 401.
 *
 * It also keeps a door open. Railway wakes a sleeping service on traffic from
 * the internet or from another service over the private network, so if
 * serverless is ever switched on for the storefront, a five-minute cron
 * calling it over HTTP would pin it permanently awake. Serverless is off as of
 * 2026-09-23; this design does not depend on that staying true.
 *
 * The route still exists, and is still the way to force a sweep by hand.
 */
async function main(): Promise<void> {
  const released = await releaseExpiredReservations();
  console.log(`[release-reservations] cancelled ${released} expired order(s)`);
}

main()
  .catch((error) => {
    console.error("[release-reservations] failed", error);
    process.exitCode = 1;
  })
  // Load-bearing. postgres.js holds the event loop open with its pool, and
  // Railway skips the next tick while a run is still alive -- so without this
  // the job would run exactly once, then go quiet behind a green dashboard.
  .finally(() => process.exit());
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add this line to `"scripts"` immediately after `"db:promote-admin"`:

```json
    "cron:release-reservations": "tsx src/lib/inventory/releaseJob.ts",
```

- [ ] **Step 3: Move `tsx` and `dotenv` to `dependencies`**

Railway builds with `NODE_ENV=production`, so devDependencies are not installed. `tsx` runs the script, and `dotenv` is imported on its first line — both would be missing, and the job would crash before reaching any code.

`dotenv` is easy to miss because the spec named only `tsx`. Check the imports of an entrypoint before assuming its runtime dependencies are declared: `db:migrate` and `db:promote-admin` import it too, so they were equally unrunnable on Railway.

Delete both from `"devDependencies"`, and add them to `"dependencies"` in alphabetical position — `dotenv` after `better-auth`, `tsx` between `stripe` and `zod`:

```json
    "better-auth": "^1.7.5",
    "dotenv": "^18.0.1",
    "drizzle-orm": "^0.45.2",
```

```json
    "stripe": "^22.6.2",
    "tsx": "^4.23.13",
    "zod": "^4.6.5"
```

- [ ] **Step 4: Register this plan with the drift guard**

`src/test/plan-drift.test.ts` only guards plans named in its `PLANS` list, and says so: a plan left off is unguarded, and the omission is silent because the suite stays green either way.

Change `PLANS` (`src/test/plan-drift.test.ts:23-26`) to:

```ts
const PLANS = [
  "docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md",
  "docs/superpowers/plans/2026-09-20-admin-orders.md",
  "docs/superpowers/plans/2026-09-23-railway-reservation-cron.md",
].map((p) => path.join(ROOT, p));
```

- [ ] **Step 5: Install, so the lockfile records the move**

Run: `npm install`

Expected: `package-lock.json` changes; no package is downloaded, since `tsx` was already present.

- [ ] **Step 6: Verify the drift guard accepts the new plan**

Run: `npm test -- src/test/plan-drift.test.ts`

Expected: PASS. The `src/lib/inventory/releaseJob.ts matches the plan byte for byte` case must appear and pass. If it fails, the code block in Step 1 and the file on disk have diverged — fix the plan to match what shipped, never the reverse.

- [ ] **Step 7: Run the job against the dev database**

Requires `docker compose up -d` and a `DATABASE_URL` in `.env`.

Run: `npm run cron:release-reservations`

Expected, on two lines that matter:
1. `[release-reservations] cancelled 0 expired order(s)` (0 is correct on a clean dev database).
2. **The shell prompt returns.** A hung prompt means the process did not exit, which is the single most likely way this job ships broken — and in production it is invisible, because Railway just silently skips every later tick.

- [ ] **Step 8: Verify it actually releases something**

Reserved stock needs a pending order with an expired reservation. Create one directly:

```bash
psql "$DATABASE_URL" -c "UPDATE orders SET reservation_expires_at = now() - interval '1 hour' WHERE status = 'pending' AND inventory_state = 'reserved';"
```

If that reports `UPDATE 0`, there is no pending reserved order to expire — place an order through `/checkout` without paying, then re-run it.

Run: `npm run cron:release-reservations`

Expected: `cancelled 1 expired order(s)` (or however many were updated), and a second run immediately after reports `cancelled 0`, confirming the sweep is not double-counting.

- [ ] **Step 9: Full suite**

Run: `npm test && npm run lint && npm run build`

Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src/lib/inventory/releaseJob.ts package.json package-lock.json src/test/plan-drift.test.ts docs/superpowers/plans/2026-09-23-railway-reservation-cron.md
git commit -m "feat: cron entrypoint for releasing expired reservations"
```

---

### Task 2: Retire `vercel.json`

**Files:**
- Delete: `vercel.json`
- Modify: `docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md:5978`, `:6193-6205`, `:6234`, `:7022-7028`
- Modify: `README.md:144-149`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. This task is removal and documentation only.

`vercel.json` is declared with a `Create` block in plan 1, which `plan-drift.test.ts` guards. Deleting the file without removing that block fails the `references no file that does not exist` case. Both must move together, in one commit.

- [ ] **Step 1: Delete the file**

```bash
git rm vercel.json
```

- [ ] **Step 2: Confirm the drift guard now fails**

Run: `npm test -- src/test/plan-drift.test.ts`

Expected: FAIL on `references no file that does not exist`, listing `vercel.json`. This is the guard doing its job — it proves the coupling in Step 3 is real and not theoretical.

- [ ] **Step 3: Remove the block from plan 1**

In `docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md`, replace the whole of Step 3 of Task 15 — its heading, the line declaring the file, and the fenced JSON block (around `:6193-6205`) — with:

```markdown
- [ ] **Step 3: Schedule the cron**

Superseded. `vercel.json` was deleted on 2026-09-23: the store deploys to
Railway, which ignores that file, so the schedule it declared never ran and
expired reservations were never released. The schedule now lives in a Railway
cron service running `npm run cron:release-reservations`. See
`docs/superpowers/plans/2026-09-23-railway-reservation-cron.md`.
```

The `Create` line must go, not just be commented out — the guard counts declarations by regex, so the words are what matter, not whether they are inside a fence.

- [ ] **Step 4: Fix the two stale references in plan 1**

At `:5978`, in Task 15's Files list, delete the line:

```markdown
- Create: `vercel.json`
```

At `:6234`, change the commit command from:

```bash
git add src/app/api vercel.json
```

to:

```bash
git add src/app/api
```

- [ ] **Step 5: Correct plan 1's deployment section**

At `:7022-7028`, replace the `## Deployment` body with:

```markdown
Railway. Set every variable from `.env.example` in the service settings, and
add the production webhook endpoint in the Stripe dashboard pointing at
`/api/stripe/webhook`. `NEXT_PUBLIC_*` variables must be set before the build,
because Next.js inlines them into the client bundle at build time. Expired
reservations are swept by a separate Railway cron service — see
`docs/superpowers/plans/2026-09-23-railway-reservation-cron.md`.
```

- [ ] **Step 6: Correct the README**

In `README.md`, replace the `## Deployment` body (`:144-149`) with:

```markdown
Railway. Set every variable from `.env.example` in the service settings, and add
the production webhook endpoint in the Stripe dashboard pointing at
`/api/stripe/webhook`.

`NEXT_PUBLIC_*` variables must be present before the build — Next.js inlines
them into the client bundle, so a value added afterwards has no effect until the
next deploy. Everything else is read at request time.

Expired reservations are released by a second Railway service running
`npm run cron:release-reservations` on a `*/5 * * * *` cron schedule. It queries
Postgres directly and never calls the storefront, so the web service is free to
sleep. `/api/cron/release-reservations` remains as a manual trigger and refuses
to run if `CRON_SECRET` is unset.
```

- [ ] **Step 7: Full suite**

Run: `npm test && npm run lint && npm run build`

Expected: all green, including the `plan-drift` case that failed in Step 2.

- [ ] **Step 8: Commit**

`git rm` in Step 1 already staged the deletion, so it needs no `git add` here.

```bash
git add README.md docs/superpowers/plans
git commit -m "chore: delete vercel.json and document Railway deployment"
```

---

### Task 3: Configure Railway

**Files:**
- Create: `.railway/railway.ts`

**Interfaces:**
- Consumes: the `cron:release-reservations` script from Task 1.
- Produces: a running schedule.

The start command and schedule live in a config file rather than in dashboard fields, so they are reviewable and survive the service being recreated. The Railway CLI cannot set a cron schedule — it is a dashboard field or a config file, nothing else — so this is the only way to keep the schedule in version control.

Do this only after Task 1 is deployed, so the script exists on the branch Railway builds.

- [ ] **Step 1: Write the config**

Railway stops honouring `railway.json` / `railway.toml` on 2026-12-01, so the
infrastructure is declared in TypeScript instead. Both JSON files this plan
originally created were deleted on 2026-09-25.

Write the file against the SDK's own type definitions, not the documentation:
the docs page omits `cronSchedule` and `restartPolicyType` entirely, and both
exist on `DeployConfig`. Reading the docs alone leads to the wrong conclusion
that IaC cannot express a cron schedule.

**Declare every resource, including Postgres.** `railway config apply` deletes
resources the file omits, so leaving the database out destroys it.

Create `.railway/railway.ts`:

```ts
import {
  defineRailway,
  github,
  postgres,
  preserve,
  project,
  service,
} from "railway/iac";

/**
 * Railway infrastructure for Coldsmoke.
 *
 * Replaces railway.json and railway.cron.json, which Railway stops honouring
 * on 2026-12-01.
 *
 * Every resource in the environment is declared here on purpose. `railway
 * config apply` deletes resources a config omits, so leaving Postgres out of
 * this file would destroy the production database.
 *
 * Secrets are declared with preserve(): the variable is asserted to exist and
 * its current value in Railway is kept, so no key is ever written into the
 * repository. DATABASE_URL is the exception -- it is a reference to the
 * Postgres service, not a secret, and Railway resolves it at deploy time.
 */
export default defineRailway(() => {
  const db = postgres("Postgres");

  const web = service("extraordinary-beauty", {
    source: github("samklepdev/coldsmoke", { branch: "main" }),

    // Runs inside Railway's network before the new version goes live. The
    // database has no public proxy, so this is the only place migrations can
    // run unattended. Depends on tsx and dotenv being in `dependencies`.
    preDeploy: "npm run db:migrate",

    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      BETTER_AUTH_SECRET: preserve(),
      BETTER_AUTH_URL: preserve(),
      CRON_SECRET: preserve(),
      EMAIL_FROM: preserve(),
      NEXT_PUBLIC_SITE_URL: preserve(),
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: preserve(),
      RESEND_API_KEY: preserve(),
      STRIPE_SECRET_KEY: preserve(),
      STRIPE_WEBHOOK_SECRET: preserve(),
    },
  });

  const cron = service("coldsmoke-cron", {
    source: github("samklepdev/coldsmoke", { branch: "main" }),
    start: "npm run cron:release-reservations",

    deploy: {
      // Five minutes is Railway's documented floor.
      cronSchedule: "*/5 * * * *",

      // NEVER, not a default worth accepting. Under ALWAYS or ON_FAILURE a
      // persistently failing job restarts forever and stays in the running
      // state -- and Railway skips a tick whenever the previous run is still
      // alive, so one bad run would silently block every future execution.
      restartPolicyType: "NEVER",
    },

    // DATABASE_URL only. CRON_SECRET authenticates the HTTP route, and this
    // job talks to Postgres directly, so it has no use for it.
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
    },
  });

  return project("bubbly-patience", {
    resources: [db, web, cron],
  });
});
```

`preserve()` asserts a variable exists and keeps whatever value Railway
already holds, so no secret is written into the repository. `DATABASE_URL` is
the exception -- it is a reference to the Postgres service, resolved at deploy
time, not a secret.

`tsconfig.json` must exclude `.railway`. `include` is `**/*.ts` and `next
build` runs `tsc`, while the `railway` SDK is a devDependency and Railway
builds with `NODE_ENV=production` -- so a type-checked config file passes
locally and fails on Railway.

Do not use `railway config migrate`. It emits a service named after the
repository rather than the real service, ignores any secondary config file,
and omits the database.

- [ ] **Step 1b: Apply it**

Run: `railway config plan`

Expected: `0 to destroy`. Anything else means a resource is missing from the
file -- stop and add it rather than applying. Then `railway config apply`, and
re-run `railway config plan` to confirm it reports no remaining changes.

- [ ] **Step 2: Create the service**

In the existing Railway project, add a new service from the same GitHub repository and branch. Name it `coldsmoke-cron`.

- [ ] **Step 3: Leave the Config File field empty**

`.railway/railway.ts` is the single source of truth. The per-service **Railway Config File** field must be blank; a path left there competes with IaC for the same settings.

Leave the build command at its default. The cron service builds a Next.js app it never serves, but that build happens once — scheduled executions reuse the cached image and start in seconds, so it does not eat into the five-minute window.

- [ ] **Step 4: Point it at the database**

In the new service's **Variables**, add `DATABASE_URL` as a reference to the same Postgres service the web service uses. Add nothing else — in particular not `CRON_SECRET`, which this path does not use.

- [ ] **Step 5: Verify one run**

Trigger a deploy and watch the logs.

Expected: `[release-reservations] cancelled N expired order(s)`, then the deployment shows a **zero exit code and stops**. A run that stays active is the failure mode from Task 1 Step 7 reaching production — Railway will skip every subsequent tick without reporting an error.

- [ ] **Step 6: Verify the cron never touches the storefront**

Only meaningful once serverless is enabled on the web service — it is off as of 2026-09-23, so skip this until then. Leave the project idle for 20 minutes, then check the web service's status.

Expected: asleep. If it is awake, something in the cron path is reaching it over HTTP.

- [ ] **Step 7: Verify the web service did not inherit the schedule**

Check the web service's Settings → Deploy. Expected: **no** cron schedule, and a start command of `npm start`.

`.railway/railway.ts` declares `cronSchedule` only on `coldsmoke-cron`, so this cannot happen — but it is worth one look, because the failure is silent and total. A storefront with a cron schedule runs once, exits, and serves nothing.

---

## Notes for the implementer

- `releaseExpiredReservations` needs no changes and gets no new tests. It already has integration coverage at `src/lib/inventory/inventory.test.ts:238`, including a concurrency case at `:282` proving two overlapping sweeps cannot double-cancel.
- The entrypoint gets no automated test of its own. It is a `main()` wrapper over covered logic, and the part that can genuinely break — that the process exits — is not observable from inside the process. Task 1 Step 7 is that check, done by eye.
- If you add anything to this plan under a `Create `path`:` heading, the file must exist and match byte for byte when the suite runs. That is the guard, not an accident.
