import type { DiscountCode } from "@/lib/db/schema";
import type { AppliedDiscount } from "@/lib/pricing/quote";
import { formatCents } from "@/lib/money";

export type DiscountFailure =
  | "not_found"
  | "inactive"
  | "not_started"
  | "expired"
  | "exhausted"
  | "below_minimum";

export type DiscountResult =
  | { ok: true; discount: AppliedDiscount }
  | { ok: false; reason: DiscountFailure };

export function validateDiscount(
  code: DiscountCode | null,
  subtotalCents: number,
  now: Date = new Date(),
): DiscountResult {
  if (!code) return { ok: false, reason: "not_found" };
  if (!code.active) return { ok: false, reason: "inactive" };
  if (code.startsAt && code.startsAt > now) {
    return { ok: false, reason: "not_started" };
  }
  if (code.endsAt && code.endsAt < now) {
    return { ok: false, reason: "expired" };
  }
  if (code.maxRedemptions !== null && code.timesRedeemed >= code.maxRedemptions) {
    return { ok: false, reason: "exhausted" };
  }
  if (subtotalCents < code.minSubtotalCents) {
    return { ok: false, reason: "below_minimum" };
  }

  return {
    ok: true,
    discount: {
      id: code.id,
      code: code.code,
      type: code.type,
      value: code.value,
    },
  };
}

export function discountFailureMessage(
  reason: DiscountFailure,
  code?: DiscountCode,
): string {
  switch (reason) {
    case "not_found":
      return "That code isn't valid.";
    case "inactive":
      return "That code is no longer active.";
    case "not_started":
      return "That code isn't active yet.";
    case "expired":
      return "That code has expired.";
    case "exhausted":
      return "That code has been fully redeemed.";
    case "below_minimum":
      return code
        ? `That code needs an order of ${formatCents(code.minSubtotalCents)} or more.`
        : "Your order is below the minimum for that code.";
  }
}

export type DiscountStatus =
  | "live"
  | "scheduled"
  | "expired"
  | "exhausted"
  | "off";

/**
 * Whether a code is usable right now, for the admin list.
 *
 * Deliberately mirrors validateDiscount's checks in the same order, so the
 * list cannot tell an admin a code is live while the cart tells a customer it
 * is not. If you change one, change the other.
 *
 * `below_minimum` has no counterpart here on purpose: it describes a
 * particular cart, not the code. A code requiring $50 is not broken, it is
 * waiting for a big enough basket.
 */
export function discountStatus(
  code: DiscountCode,
  now: Date = new Date(),
): DiscountStatus {
  if (!code.active) return "off";
  if (code.startsAt && code.startsAt > now) return "scheduled";
  if (code.endsAt && code.endsAt < now) return "expired";
  if (code.maxRedemptions !== null && code.timesRedeemed >= code.maxRedemptions) {
    return "exhausted";
  }
  return "live";
}
