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
   * list therefore cannot drift out of date.
   *
   * The list reached [] on 2026-09-21: legalName, addressLine1,
   * addressLocality and supportEmail were all filled in. The assertion stays
   * rather than being deleted -- empty is now the meaningful state, and this
   * is what fails if a new bracketed placeholder is ever introduced.
   *
   * What it does NOT catch: a value that reads like a stand-in but carries no
   * bracketed marker. isPending only recognises brackets, so a plausible
   * wrong answer settles silently. These four render into the Terms and
   * Privacy pages, so they want a human eye, not just a green test.
   */
  it("has no details left waiting on the LLC", () => {
    expect(PENDING_BUSINESS_DETAILS).toEqual([]);
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
