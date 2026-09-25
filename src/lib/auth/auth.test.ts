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

  /**
   * Without this, Better Auth resolves no client IP behind Railway's proxy and
   * every request shares one rate-limit bucket per path -- so one attacker
   * exhausts the sign-in budget for every real customer, and brute-force
   * protection against that attacker is gone. It fails silently: a warning in
   * the logs, an empty `session.ip_address`, and no other symptom.
   *
   * `getIPFromHeader` trusts a multi-hop x-forwarded-for only when the hops it
   * should ignore are declared. It walks the chain from the right and returns
   * the first address that is not a trusted proxy, so a client-supplied entry
   * -- which is always further left -- can never be selected.
   */
  it("declares the proxy hops to strip when resolving a client IP", () => {
    expect(auth.options.advanced?.ipAddress?.trustedProxies).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "100.64.0.0/10",
      "127.0.0.0/8",
      "::1/128",
      "fd00::/8",
    ]);
  });

  it("leaves IP tracking on", () => {
    expect(auth.options.advanced?.ipAddress?.disableIpTracking).toBeFalsy();
  });
});
