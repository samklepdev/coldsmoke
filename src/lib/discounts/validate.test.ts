import { describe, it, expect } from "vitest";
import { validateDiscount, discountFailureMessage, discountStatus } from "./validate";
import type { DiscountCode } from "@/lib/db/schema";

const NOW = new Date("2026-06-15T12:00:00Z");

function code(overrides: Partial<DiscountCode> = {}): DiscountCode {
  return {
    id: "d1",
    code: "welcome10",
    type: "percent",
    value: 10,
    minSubtotalCents: 0,
    maxRedemptions: null,
    timesRedeemed: 0,
    startsAt: null,
    endsAt: null,
    active: true,
    ...overrides,
  } as DiscountCode;
}

describe("validateDiscount", () => {
  it("accepts a valid code", () => {
    const result = validateDiscount(code(), 4500, NOW);
    expect(result).toEqual({
      ok: true,
      discount: { id: "d1", code: "welcome10", type: "percent", value: 10 },
    });
  });

  it("rejects a missing code", () => {
    expect(validateDiscount(null, 4500, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("rejects an inactive code", () => {
    expect(validateDiscount(code({ active: false }), 4500, NOW)).toEqual({
      ok: false,
      reason: "inactive",
    });
  });

  it("rejects a code that has not started", () => {
    const c = code({ startsAt: new Date("2026-07-01T00:00:00Z") });
    expect(validateDiscount(c, 4500, NOW)).toEqual({
      ok: false,
      reason: "not_started",
    });
  });

  it("accepts a code whose start has passed", () => {
    const c = code({ startsAt: new Date("2026-01-01T00:00:00Z") });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });

  it("rejects an expired code", () => {
    const c = code({ endsAt: new Date("2026-06-01T00:00:00Z") });
    expect(validateDiscount(c, 4500, NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("accepts a code expiring in the future", () => {
    const c = code({ endsAt: new Date("2026-12-31T00:00:00Z") });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });

  it("rejects a code at its redemption cap", () => {
    const c = code({ maxRedemptions: 5, timesRedeemed: 5 });
    expect(validateDiscount(c, 4500, NOW)).toEqual({
      ok: false,
      reason: "exhausted",
    });
  });

  it("accepts a code below its redemption cap", () => {
    const c = code({ maxRedemptions: 5, timesRedeemed: 4 });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });

  it("rejects a subtotal below the minimum", () => {
    const c = code({ minSubtotalCents: 5000 });
    expect(validateDiscount(c, 4500, NOW)).toEqual({
      ok: false,
      reason: "below_minimum",
    });
  });

  it("accepts a subtotal exactly at the minimum", () => {
    const c = code({ minSubtotalCents: 4500 });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });

  it("accepts a code whose startsAt is exactly now", () => {
    const c = code({ startsAt: NOW });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });

  it("accepts a code whose endsAt is exactly now", () => {
    const c = code({ endsAt: NOW });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });
});

describe("discountFailureMessage", () => {
  it("explains the minimum in dollars", () => {
    const message = discountFailureMessage(
      "below_minimum",
      code({ minSubtotalCents: 5000 }),
    );
    expect(message).toContain("$50.00");
  });

  it("returns a message for every failure reason", () => {
    const reasons = [
      "not_found",
      "inactive",
      "not_started",
      "expired",
      "exhausted",
    ] as const;
    for (const reason of reasons) {
      expect(discountFailureMessage(reason)).toBeTruthy();
    }
  });

  it("falls back to a generic message when below_minimum has no code", () => {
    expect(discountFailureMessage("below_minimum")).toBe(
      "Your order is below the minimum for that code.",
    );
  });
});

describe("discountStatus", () => {
  const base = {
    id: "00000000-0000-0000-0000-000000000001",
    code: "spring",
    type: "percent" as const,
    value: 15,
    minSubtotalCents: 0,
    maxRedemptions: null as number | null,
    timesRedeemed: 0,
    startsAt: null as Date | null,
    endsAt: null as Date | null,
    active: true,
    // Present only to satisfy DiscountCode. discountStatus must never read
    // it: when a code was made says nothing about whether it is usable now.
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  const now = new Date("2026-06-15T12:00:00Z");

  it("is live when nothing stands in the way", () => {
    expect(discountStatus(base, now)).toBe("live");
  });

  it("is off when deactivated", () => {
    expect(discountStatus({ ...base, active: false }, now)).toBe("off");
  });

  it("is scheduled before its start date", () => {
    expect(
      discountStatus({ ...base, startsAt: new Date("2026-07-01T00:00:00Z") }, now),
    ).toBe("scheduled");
  });

  it("is expired after its end date", () => {
    expect(
      discountStatus({ ...base, endsAt: new Date("2026-06-01T00:00:00Z") }, now),
    ).toBe("expired");
  });

  it("is exhausted once the cap is reached", () => {
    expect(
      discountStatus({ ...base, maxRedemptions: 5, timesRedeemed: 5 }, now),
    ).toBe("exhausted");
  });

  it("reports expired rather than live for a code still flagged active", () => {
    // The whole reason this derivation exists: `active` is not the same
    // question as "can a customer use this right now".
    const code = { ...base, active: true, endsAt: new Date("2026-01-01T00:00:00Z") };

    expect(code.active).toBe(true);
    expect(discountStatus(code, now)).toBe("expired");
  });

  it("ignores the minimum subtotal, which is a property of a cart", () => {
    // validateDiscount can fail with below_minimum; that says nothing about
    // whether the code itself is usable, so it must not appear here.
    expect(discountStatus({ ...base, minSubtotalCents: 50_000 }, now)).toBe("live");
  });
});
