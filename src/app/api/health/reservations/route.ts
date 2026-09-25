import { and, eq, lt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { db } from "@/lib/db/client";
import { orders } from "@/lib/db/schema";

/**
 * How far behind the sweep may fall before something is wrong.
 *
 * The cron runs every five minutes. Railway skips a tick whenever the previous
 * run is still alive, so one skipped tick is normal and not worth waking
 * anyone for. Three consecutive misses is not.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Reports reservations the sweep should already have released.
 *
 * This exists because the cron's failure mode is silence. Railway skips a tick
 * when the previous run has not exited, reports nothing, and keeps the
 * dashboard green -- so "the job is fine" and "the job has not run since
 * Tuesday" look identical from outside. What is observable is the consequence:
 * expired reservations piling up, holding stock that nobody can buy.
 *
 * Deliberately NOT part of /api/health. That route is Railway's deploy
 * prober, and a stalled cron does not mean the app is unhealthy -- wiring this
 * into it would fail deploys for an unrelated reason.
 *
 * Authenticated with CRON_SECRET: the count is a live read of order state, and
 * an unauthenticated endpoint that reports how much stock is stuck is a free
 * signal to anyone probing the store.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - STALE_AFTER_MS);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.status, "pending"),
        eq(orders.inventoryState, "reserved"),
        lt(orders.reservationExpiresAt, cutoff),
      ),
    );

  const stale = row?.count ?? 0;

  // 503 rather than a 200 carrying a count, so a monitor that only knows about
  // status codes still notices. A caller that wants the number still gets it.
  return NextResponse.json({ ok: stale === 0, stale }, {
    status: stale === 0 ? 200 : 503,
  });
}
