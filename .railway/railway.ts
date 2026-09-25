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

    // Without this Railway only checks that the port opened, which a container
    // that cannot reach Postgres does perfectly well -- it boots, serves, and
    // throws on every page. The route runs `select 1`, so a bad DATABASE_URL
    // or an unreachable database fails the deploy instead of being promoted.
    healthcheck: "/api/health",
    healthcheckTimeout: 30,

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
