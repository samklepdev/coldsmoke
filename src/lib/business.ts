/**
 * Every business fact the site's copy depends on.
 *
 * One module because the same fact appears on several pages — the return
 * window is in both the FAQ and Shipping & Returns — and updating one page
 * while missing another is how policy pages start contradicting each other.
 *
 * Free of server-only imports, for the same reason `src/lib/cookies.ts` and
 * `src/lib/cart/limits.ts` are: a Client Component may need to render the
 * support address, and importing a module that reaches the database would
 * drag the driver into the browser bundle.
 */

/**
 * A fact that is not settled yet is written as a bracketed marker. It renders
 * literally — "[legal name]" — rather than as an empty string, so an unfilled
 * fact is visible on the page instead of quietly dropping a word out of a
 * sentence.
 */
export const BUSINESS = {
  legalName: "[legal name]",
  addressLine1: "[street address]",
  addressLocality: "[city, state, ZIP]",
  supportEmail: "[support email]",

  // Confirmed by the owner, 2026-09-20. Not placeholders.
  returnWindowDays: 30,
  returnCondition: "unopened",
  governingState: "Texas",
  supportResponseHours: 48,
} as const;

const MARKER = /^\[.+\]$/;

/** The single rule that defines "pending". */
export function isPending(value: unknown): boolean {
  return typeof value === "string" && MARKER.test(value);
}

/**
 * Sorted so the guard's expected list is stable regardless of key order.
 */
export const PENDING_BUSINESS_DETAILS: string[] = Object.entries(BUSINESS)
  .filter(([, value]) => isPending(value))
  .map(([key]) => key)
  .sort();
