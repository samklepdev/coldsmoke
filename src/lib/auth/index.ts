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
      await sendVerificationEmail({ to: user.email, url });
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
