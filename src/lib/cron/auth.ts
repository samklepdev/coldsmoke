import { timingSafeEqual } from "node:crypto";

/**
 * Shared by every route that only an operator or a scheduler may call.
 *
 * Extracted from the release-reservations route rather than copied: this is
 * the kind of comparison that is subtly wrong when reimplemented, and a second
 * copy is a second place to forget the fail-closed branch below.
 */
export function isAuthorizedCronRequest(header: string | null): boolean {
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
