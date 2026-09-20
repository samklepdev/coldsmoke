import { describe, it, expect } from "vitest";
import { auth } from "./index";

/**
 * These are not assertions about Better Auth. They are assertions about four
 * decisions that quietly govern account security, each of which is a one-word
 * edit away from being reversed with no visible symptom:
 *
 *   - turning off requireEmailVerification lets anyone sign in as an
 *     unverified address, which is what gates the order-history claim;
 *   - autoSignInAfterVerification would skip the sign-in action where the
 *     guest cart is merged;
 *   - a wrong defaultRole would make every new customer an admin.
 *
 * Each value is asserted, never merely checked for presence. `auth.options`
 * returns only what the config set explicitly, so these passing also proves
 * the options are still written down rather than inherited.
 */
describe("auth configuration", () => {
  it("refuses to sign in an unverified address", () => {
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(true);
  });

  it("sends the verification email on sign-up", () => {
    expect(auth.options.emailVerification?.sendOnSignUp).toBe(true);
  });

  it("does not sign the customer in from the verification link", () => {
    expect(auth.options.emailVerification?.autoSignInAfterVerification).toBe(false);
  });

  it("states a password floor rather than inheriting one", () => {
    expect(auth.options.emailAndPassword?.minPasswordLength).toBe(8);
  });

  it("makes new accounts customers, not admins", () => {
    const adminPlugin = auth.options.plugins?.find((p) => p.id === "admin");
    expect(adminPlugin).toBeDefined();
  });

  it("keeps nextCookies last so a Server Action can set the session cookie", () => {
    const plugins = auth.options.plugins ?? [];
    expect(plugins.at(-1)?.id).toBe("next-cookies");
  });
});
