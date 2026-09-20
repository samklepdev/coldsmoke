import { describe, it, expect, beforeEach } from "vitest";
import { recordDelivery, takeDelivery } from "./delivery";

beforeEach(() => {
  // Drain anything a previous test left behind.
  takeDelivery("buyer@example.com");
  takeDelivery("other@example.com");
});

/**
 * Better Auth calls our sendVerificationEmail hook from inside signUpEmail and
 * discards whatever it returns -- and swallows anything it throws. Measured on
 * 2026-09-20: a hook that throws still resolves signUpEmail and still creates
 * the user. So a failed send cannot travel back to the Server Action by return
 * value or by exception, and without this handoff the action tells the
 * customer "check your email" for mail that was never accepted.
 */
describe("delivery handoff", () => {
  it("hands a failure to the reader", () => {
    recordDelivery("buyer@example.com", false);

    expect(takeDelivery("buyer@example.com")).toBe(false);
  });

  it("hands a success to the reader", () => {
    recordDelivery("buyer@example.com", true);

    expect(takeDelivery("buyer@example.com")).toBe(true);
  });

  it("reports nothing when no send was recorded", () => {
    // The caller must be able to tell "not sent" from "no information",
    // because only the first one is worth telling the customer about.
    expect(takeDelivery("buyer@example.com")).toBeUndefined();
  });

  it("consumes the record so it cannot be read twice", () => {
    recordDelivery("buyer@example.com", false);
    takeDelivery("buyer@example.com");

    // A leftover record would make the NEXT sign-up with this address report
    // a failure that already happened.
    expect(takeDelivery("buyer@example.com")).toBeUndefined();
  });

  it("keeps addresses separate", () => {
    recordDelivery("buyer@example.com", false);

    expect(takeDelivery("other@example.com")).toBeUndefined();
    expect(takeDelivery("buyer@example.com")).toBe(false);
  });

  it("matches addresses case-insensitively", () => {
    // Better Auth lowercases; the form does not.
    recordDelivery("Buyer@Example.com", false);

    expect(takeDelivery("buyer@example.com")).toBe(false);
  });
});
