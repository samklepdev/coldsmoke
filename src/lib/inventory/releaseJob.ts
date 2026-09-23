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
