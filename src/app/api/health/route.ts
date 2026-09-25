import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";

/**
 * Deployment healthcheck for Railway.
 *
 * It queries the database rather than returning a bare 200, because a bare 200
 * only proves the port is open -- which is the one thing Railway can already
 * see. The failure this exists to catch is a container that boots and serves
 * while unable to reach Postgres: a wrong DATABASE_URL, a database that has not
 * finished starting, a connection limit. Without a healthcheck Railway promotes
 * that deployment and every page starts throwing.
 *
 * `select 1` is deliberate. It proves a connection can be acquired and a
 * round trip completes, and it touches no table, so the check cannot start
 * failing because of a schema change.
 *
 * Unauthenticated on purpose: Railway's prober carries no credentials. The
 * body says nothing beyond up or down, and the error is logged rather than
 * returned, so a failure does not hand out connection details.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[health] database unreachable", error);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
