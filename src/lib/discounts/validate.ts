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
