import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendExistingAccountEmail,
} from "@/lib/email/auth";
import { recordDelivery } from "@/lib/email/delivery";
import { claimGuestOrders } from "@/lib/orders/claim";

/**
 * The Better Auth server instance. The only place `betterAuth()` is called.
 *
 * Every security-relevant option below is stated explicitly rather than left
 * to a default, including options whose default is already what we want.
 * `auth.options` reads back only what was set here -- an inherited default
 * comes back `undefined` -- so a value that is not written down cannot be
 * asserted by the guard in auth.test.ts, and therefore cannot be protected
 * from a silent change.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,

  advanced: {
    ipAddress: {
      /**
       * Railway terminates TLS at its edge and forwards, so `x-forwarded-for`
       * arrives with more than one hop. Better Auth trusts a multi-hop header
       * only when the hops to ignore are declared: with none, `getIPFromHeader`
       * bails on `forwardedIps.length !== 1` and returns null.
       *
       * The consequence is not a missing field. Rate limiting then keys on a
       * single shared bucket per path, so one attacker exhausts the sign-in
       * budget for every customer at once, and per-attacker brute-force
       * protection stops existing. Observed in production as a logged warning
       * and an empty `session.ip_address`, with nothing else to notice.
       *
       * These are the private and CGNAT ranges an internal hop can occupy --
       * the running container sits on 10.x. Declaring them is safe against
       * spoofing: the chain is walked from the right and the first untrusted
       * address wins, and anything a client prepends is further left, so it is
       * never reached.
       */
      trustedProxies: [
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "::1/128",
        "fd00::/8",
      ],

      // Stated rather than inherited, like every other option here. Turning it
      // on would return null from getIP and put us straight back to one shared
      // rate-limit bucket -- the exact failure the trustedProxies above fix.
      disableIpTracking: false,
    },
  },

  emailAndPassword: {
    enabled: true,
    // An unverified account cannot sign in. This is what makes a verified
    // email mean something, which is in turn what makes it safe to hand a
    // guest order history to whoever proves they own the address.
    requireEmailVerification: true,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ to: user.email, url });
    },
    /**
     * Someone tried to sign up with an address that already has an account.
     *
     * Better Auth answers that attempt with a fabricated success response --
     * a plausible user object that is never persisted -- so the browser
     * cannot tell a taken address from a free one. It also hashes the
     * submitted password first, so the two paths take comparable time.
     *
     * That leaves the real account holder as the only one who should learn
     * anything, which is what this hook is for. Measured on 2026-09-20: this
     * fires only because `requireEmailVerification` is true, which is what
     * flips Better Auth into the generic-response path.
     */
    onExistingUserSignUp: async ({ user }) => {
      await sendExistingAccountEmail({
        to: user.email,
        url: `${process.env.BETTER_AUTH_URL ?? ""}/sign-in`,
      });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    // Deliberately false. Signing the customer in from the verification link
    // would skip our sign-in action, which is where the guest cart is merged.
    // One code path for post-sign-in work is worth one extra sign-in.
    autoSignInAfterVerification: false,
    sendVerificationEmail: async ({ user, url }) => {
      const { delivered } = await sendVerificationEmail({ to: user.email, url });
      // Better Auth discards what this hook returns and swallows what it
      // throws, so the result is handed to the Server Action out of band.
      // Without it sign-up reports success for mail that was rejected.
      recordDelivery(user.email, delivered);
    },
    /**
     * The moment the address stops being a claim and becomes proof.
     *
     * Database work only. Better Auth runs this from its own GET handler for
     * the verification link, so anything needing cookies belongs in a Server
     * Action instead, where cookie access is defined.
     */
    afterEmailVerification: async (user) => {
      const claimed = await claimGuestOrders({ userId: user.id, email: user.email });
      if (claimed > 0) {
        console.info("[auth] claimed guest orders", { userId: user.id, claimed });
      }
    },
  },

  plugins: [
    // Supplies user.role, plus the ban and impersonation columns Plan C needs.
    // Adding it now costs one migration; adding it later costs another.
    admin({ defaultRole: "customer", adminRoles: ["admin"] }),
    // MUST be last: it wraps the handlers so a Server Action can set the
    // session cookie. A plugin registered after it is not wrapped.
    nextCookies(),
  ],
});
