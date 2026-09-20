import { describe, it, expect } from "vitest";
import { BUSINESS, PENDING_BUSINESS_DETAILS, isPending } from "./business";

describe("business details", () => {
  /**
   * Deliberately an exact-equality assertion against an allowlist, not a
   * "no placeholders" check behind a launch flag. A flagged check never fires
   * until launch day, which is the failure family this project has already
   * shipped three times.
   *
   * Consequences, both intended: adding a new placeholder fails here, and
   * filling one in ALSO fails here until it is removed from this list. The
   * list therefore cannot drift out of date. When it reaches [], the business
   * details are complete.
   */
  it("lists exactly the details still waiting on the LLC", () => {
    expect(PENDING_BUSINESS_DETAILS).toEqual([
      "addressLine1",
      "addressLocality",
      "legalName",
      "supportEmail",
    ]);
  });

  it("treats a bracketed marker as pending", () => {
    expect(isPending("[legal name]")).toBe(true);
  });

  it("treats a filled-in value as settled", () => {
    expect(isPending("Coldsmoke LLC")).toBe(false);
  });

  it("does not treat a number as pending", () => {
    expect(isPending(30)).toBe(false);
  });

  it("keeps the terms the owner confirmed on 2026-09-20", () => {
    expect(BUSINESS.returnWindowDays).toBe(30);
    expect(BUSINESS.returnCondition).toBe("unopened");
    expect(BUSINESS.governingState).toBe("Texas");
  });
});
