import "dotenv/config";
import { releaseExpiredReservations } from "./index";

/**
 * Releases stock held by abandoned checkouts, and cancels the orders holding it.
 *
 * Run by a Railway cron service every five minutes. It queries Postgres
 * directly rather than calling /api/cron/release-reservations, because the web
 * service runs with serverless enabled: Railway wakes a service on traffic from
 * the internet or from another service over the private network, so a
 * five-minute cron reaching it over HTTP would keep the storefront permanently
 * awake and remove the reason serverless is on.
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
