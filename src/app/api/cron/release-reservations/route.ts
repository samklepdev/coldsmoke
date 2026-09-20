import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { releaseExpiredReservations } from "@/lib/inventory";

function isAuthorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;

  // Fail closed. Without this the comparison below would be against the
  // literal string "Bearer undefined", which anyone could send.
  if (!secret) {
    console.error("[cron] CRON_SECRET is not set; refusing to run");
    return false;
  }

  if (!header) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  // timingSafeEqual throws on a length mismatch, so check that first — the
  // length of the secret is not itself worth protecting.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function GET(request: Request) {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const released = await releaseExpiredReservations();
  return NextResponse.json({ released });
}
