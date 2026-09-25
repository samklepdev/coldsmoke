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
   * The list reached [] on 2026-09-21 and went back to three entries on
   * 2026-09-25. legalName, addressLine1 and addressLocality had all been
   * filled in with plausible stand-ins -- "Meridian Fragrance, LLC",
   * "123 Main Street", "Houston, TX 77023" -- and none carried a marker, so
   * the list read empty while the deployed Privacy and Terms pages published
   * a fabricated entity at a fabricated address. Exactly the hole described
   * below, shipped.
   *
   * What this does NOT catch: a value that reads like a stand-in but carries
   * no bracketed marker. isPending only recognises brackets, so a plausible
   * wrong answer settles silently. These four render into the Terms and
   * Privacy pages, so they want a human eye, not just a green test.
   *
   * supportEmail is deliberately NOT bracketed despite being unusable -- its
   * domain is unregistered, so the address bounces. contact/actions.ts passes
   * it to Resend as the `to`, so a bracketed value would not render a visible
   * marker, it would break the contact form. Fix it by registering the
   * domain, not by marking it pending.
   */
  it("has no details left waiting on the LLC", () => {
    expect(PENDING_BUSINESS_DETAILS).toEqual([
      "addressLine1",
      "addressLocality",
      "legalName",
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
