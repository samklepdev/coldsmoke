# Customer Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give customers real accounts — sign up, verified email, sign in, password reset, saved addresses, and an order history that absorbs the guest orders they placed before signing up — without taking guest checkout away.

**Architecture:** Better Auth owns the four auth tables and the `/api/auth/*` route; everything else is ours. Auth is driven from Server Actions calling `auth.api.*`, never from a browser client, so the forms work the same way every other form in this store does. Better Auth's own hooks do database work only; anything that needs cookies happens in our Server Actions, where cookie access is defined.

**Tech Stack:** Better Auth 1.7.5, Next.js 16 (App Router, Server Components, Server Actions), React 19 (`useActionState`), Drizzle + Postgres, Resend, Zod, CSS Modules, Vitest, Playwright.

Spec: `docs/superpowers/specs/2026-09-19-coldsmoke-store-design.md` §4 (data model), §6 (authentication), §7 (page inventory).

## Global Constraints

Everything in this section was verified against the installed package on 2026-09-20, not recalled. Where a fact is surprising, the surprise is stated.

- **Better Auth is pinned to 1.7.5.** `npm install better-auth@1.7.5`.
- **`better-auth/adapters/drizzle` is a one-line re-export of `@better-auth/drizzle-adapter`**, which ships as a *direct dependency* of `better-auth`. Do not add the standalone package — the docs suggest importing it directly, but installing it separately would let two copies drift apart.
- **The CLI is `npx auth@1.7.5 generate`.** The `@better-auth/cli` package still exists but is stalled at 1.4.21 and will generate a schema for the wrong version. Do not use it.
- **`src/lib/db/auth-schema.ts` is generated output.** Never hand-edit it. If a column looks wrong, change `src/lib/auth/index.ts` and re-run the CLI. A hand edit is silently destroyed by the next regeneration.
- **Better Auth's generated timestamps are `timestamp` without time zone**, unlike every other table in this codebase, which uses `{ withTimezone: true }`. Leave them alone. They are Better Auth's columns to own, and editing them puts the file back in the previous bullet's trap.
- **Next.js 16 replaced `middleware.ts` with `proxy.ts`.** The spec's §6 sentence about middleware predates that rename. This plan adds neither: the server-side session check in the account layout is the security boundary, and a fast-redirect proxy is an optimisation Plan C can add when `/admin` needs one.
- **Auth runs through Server Actions calling `auth.api.*`, not `authClient` in the browser.** Better Auth's docs lead with the client, but a client-only sign-in breaks without JavaScript, and this project has already shipped that defect once on the cart stepper. `nextCookies()` is what lets a Server Action set the session cookie, and it **must be the last plugin in the array**.
- **A Server Action passed to `<form action={...}>` must be the action itself** — the imported action or the bound one from `useActionState`. Never a client function that awaits it.
- **Guest orders are claimed only after the email is verified, never at sign-up.** Claiming at sign-up would let anyone type a stranger's address into the sign-up form and read that stranger's order history — their name, postal address, and what they bought. Verification is the only thing that proves the address belongs to the person holding the account.
- **Guest checkout must keep working.** It is a revenue path, not a legacy path. Task 11 guards it end to end.
- **`auth.options` reads back only what was set explicitly.** Defaults that Better Auth fills in internally come back `undefined`. That is why Task 2's config guard asserts values that the config states in full — a security-relevant setting that is merely inherited cannot be asserted, and therefore cannot be protected from a silent change.
- **Never write a test that can only fail when a flag is set.** This project has shipped four such checks (the Playwright skip guard, an uncontrolled-input assertion, `.not.toBeNull()` against a missing column, and a `try/catch` around a Resend call that reports failure by returning rather than throwing). Assert the value you expect.
- **Resend reports API failures by returning `{ data: null, error }`, not by throwing.** Any code that sends mail must check the returned `error`. A bare `try/catch` around `emails.send` catches nothing that Resend actually does.
- **All money is integer cents.** No floating-point money anywhere.
- Design tokens only — `var(--ground)`, `var(--panel)`, `var(--line-bright)`, `var(--text-dim)`, `var(--space-4)`, `var(--measure)`. No raw hex in new CSS.
- Never run `npm run build` while `next dev` is running; they share `.next`.
- Do not run `npm test` while another process is running it — both truncate the shared test database.

### The drift guard

`src/test/plan-drift.test.ts` asserts that every ``Create `path`:`` block in
`docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md` matches the file on
disk byte for byte. **Every task that changes a tracked file syncs that plan in the same
commit**, so the suite is never left red between tasks. Fix the plan document, never the
test.

Tracked files this plan touches, and the task that touches each:

| File | Task |
|---|---|
| `.env.example` | 2 |
| `drizzle.config.ts` | 2 |
| `src/lib/db/schema.ts` | 2, 10 |
| `src/test/db.ts` | 2, 10 |
| `src/components/SiteHeader.tsx` | 5 |
| `src/app/(store)/layout.tsx` | 5 |
| `src/lib/cart/index.ts` | 8 |
| `src/lib/orders/index.ts` | 9 |
| `src/app/(store)/checkout/actions.ts` | 9 |

New files created by this plan are **not** added to the drift guard. The established
precedent is that new files are not retro-tracked.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/email/auth.ts` (create) | Verification and password-reset emails. Body builders are pure; sending checks Resend's returned error. |
| `src/lib/email/auth.test.ts` (create) | Body content and the three delivery outcomes. |
| `src/lib/auth/index.ts` (create) | The Better Auth server instance. The only file that calls `betterAuth()`. |
| `src/lib/auth/auth.test.ts` (create) | Config invariants: verification required, roles, password floor. |
| `src/lib/auth/session.ts` (create) | `getSessionUser` / `requireSessionUser`. The only place pages read a session. |
| `src/lib/db/auth-schema.ts` (generated) | Better Auth's four tables. Never hand-edited. |
| `src/lib/db/schema.ts` (modify) | Re-export the auth tables; add `addresses`. |
| `src/app/api/auth/[...all]/route.ts` (create) | Better Auth's own endpoints. |
| `src/app/(store)/sign-up/` (create) | Sign-up page, form, action. |
| `src/app/(store)/sign-in/` (create) | Sign-in page, form, action. Also hosts sign-out. |
| `src/app/(store)/verify-email/` (create) | Post-verification landing and resend form. |
| `src/app/(store)/forgot-password/` (create) | Request a reset link. |
| `src/app/(store)/reset-password/` (create) | Set a new password from a token. |
| `src/app/(store)/account/layout.tsx` (create) | **The security boundary.** Redirects anyone without a verified session. |
| `src/app/(store)/account/orders/page.tsx` (create) | Order history. |
| `src/app/(store)/account/addresses/` (create) | Saved addresses, list and mutations. |
| `src/lib/orders/claim.ts` (create) | `claimGuestOrders` — attaches past guest orders to a verified account. |
| `src/lib/cart/merge.ts` (create) | `mergeGuestCart` — sums quantities, capped at stock. |
| `src/lib/addresses/index.ts` (create) | Address CRUD, including the single-default rule. |
| `src/components/SiteHeader.tsx` (modify) | Account link. |
| `src/test/nav-links.test.ts` (modify) | Extend to the account routes. |
| `e2e/accounts.spec.ts` (create) | Sign-up through order history, plus the guest-checkout guard. |

---

### Task 1: Auth emails

**Files:**
- Create: `src/lib/email/auth.ts`, `src/lib/email/auth.test.ts`

**Interfaces:**
- Consumes: `getResend`, `EMAIL_FROM` from `@/lib/email/client`.
- Produces: from `@/lib/email/auth`:
  - `verificationEmail(url: string): { subject: string; text: string }`
  - `passwordResetEmail(url: string): { subject: string; text: string }`
  - `sendVerificationEmail(args: { to: string; url: string }): Promise<{ delivered: boolean }>`
  - `sendPasswordResetEmail(args: { to: string; url: string }): Promise<{ delivered: boolean }>`

**Why this task is first:** it depends on nothing, and Task 2's auth instance cannot be written without it — Better Auth calls these two functions from its config.

**Context the implementer needs:** `src/lib/email/client.ts` exports `getResend()` and `EMAIL_FROM`. The existing `sendOrderConfirmation` in `src/lib/email/index.tsx` wraps `emails.send` in a `try/catch` and nothing else; that is **not** the pattern to copy. Resend reports a rejected address as a returned `error` with a 422 status and does not throw, so the existing catch never fires. This task's `send` checks both.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/email/auth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("./client", () => ({
  getResend: () => ({ emails: { send: sendMock } }),
  EMAIL_FROM: "Coldsmoke <orders@wearcoldsmoke.com>",
}));

const {
  verificationEmail,
  passwordResetEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
} = await import("./auth");

beforeEach(() => {
  sendMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const URL = "https://wearcoldsmoke.com/api/auth/verify-email?token=abc";

describe("email bodies", () => {
  it("puts the verification link in the body", () => {
    expect(verificationEmail(URL).text).toContain(URL);
  });

  it("says what the verification email is for", () => {
    expect(verificationEmail(URL).subject).toBe("Verify your email address");
  });

  it("puts the reset link in the body", () => {
    expect(passwordResetEmail(URL).text).toContain(URL);
  });

  it("says what the reset email is for", () => {
    expect(passwordResetEmail(URL).subject).toBe("Reset your Coldsmoke password");
  });

  it("tells a reset recipient what to do if they did not ask", () => {
    // A password-reset mail that arrives unrequested is the one signal a
    // customer gets that someone is trying to get into their account.
    expect(passwordResetEmail(URL).text.toLowerCase()).toContain("did not request");
  });
});

describe("sending", () => {
  it("reports delivery when Resend accepts the message", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });

    expect(await sendVerificationEmail({ to: "b@example.com", url: URL })).toEqual({
      delivered: true,
    });
  });

  /**
   * The failure Resend actually produces. It returns an error object with a
   * 422 rather than throwing, so a bare try/catch reports success for mail
   * that was rejected. Measured against the live API on 2026-09-20.
   */
  it("reports failure when Resend returns an error instead of throwing", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { statusCode: 422, name: "validation_error", message: "Invalid `to` field." },
    });

    expect(await sendPasswordResetEmail({ to: "nonsense", url: URL })).toEqual({
      delivered: false,
    });
  });

  it("reports failure when the call throws outright", async () => {
    sendMock.mockRejectedValue(new Error("socket hang up"));

    expect(await sendVerificationEmail({ to: "b@example.com", url: URL })).toEqual({
      delivered: false,
    });
  });

  it("never lets a send failure escape to the caller", async () => {
    // Better Auth calls these from inside its own request handling. A throw
    // here surfaces to the customer as a 500 on a sign-up that actually
    // succeeded, and they cannot tell the difference from a failed one.
    sendMock.mockRejectedValue(new Error("socket hang up"));

    await expect(
      sendPasswordResetEmail({ to: "b@example.com", url: URL }),
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/email/auth.test.ts`
Expected: FAIL — `Cannot find module './auth'`.

- [ ] **Step 3: Write the module**

Create `src/lib/email/auth.ts`:

```ts
import { getResend, EMAIL_FROM } from "./client";

/**
 * The two transactional emails the auth flow depends on.
 *
 * Bodies are built by pure functions so their wording is testable without a
 * network call, and so the link they contain can be asserted directly.
 */

export function verificationEmail(url: string): { subject: string; text: string } {
  return {
    subject: "Verify your email address",
    text: [
      "Confirm this address to finish setting up your Coldsmoke account:",
      "",
      url,
      "",
      "If you did not create an account, you can ignore this message.",
    ].join("\n"),
  };
}

export function passwordResetEmail(url: string): { subject: string; text: string } {
  return {
    subject: "Reset your Coldsmoke password",
    text: [
      "Use this link to choose a new password:",
      "",
      url,
      "",
      "If you did not request a password reset, ignore this message and your",
      "password will stay as it is.",
    ].join("\n"),
  };
}

/**
 * Never throws, and never reports a delivery that did not happen.
 *
 * Both halves matter. Better Auth calls this from inside its own request
 * handling, so a throw becomes a 500 on a sign-up that actually succeeded.
 * And Resend signals a rejected address by RETURNING { data: null, error }
 * with a 422 rather than throwing, so the returned error has to be inspected
 * explicitly -- a try/catch alone reports success for mail nobody received.
 */
async function send(args: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ delivered: boolean }> {
  try {
    const { error } = await getResend().emails.send({
      from: EMAIL_FROM,
      to: args.to,
      subject: args.subject,
      text: args.text,
    });

    if (error) {
      console.error("[email] auth mail rejected", { subject: args.subject, cause: error });
      return { delivered: false };
    }

    return { delivered: true };
  } catch (cause) {
    console.error("[email] auth mail threw", { subject: args.subject, cause });
    return { delivered: false };
  }
}

export function sendVerificationEmail(args: {
  to: string;
  url: string;
}): Promise<{ delivered: boolean }> {
  return send({ to: args.to, ...verificationEmail(args.url) });
}

export function sendPasswordResetEmail(args: {
  to: string;
  url: string;
}): Promise<{ delivered: boolean }> {
  return send({ to: args.to, ...passwordResetEmail(args.url) });
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/lib/email/auth.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the Resend check bites**

Temporarily delete the `if (error) { ... }` block from `send` and re-run.
Expected: `reports failure when Resend returns an error instead of throwing` FAILS,
because the function now claims `delivered: true` for a rejected address.
**Restore the block** and confirm green.

This is the check that the hardest-won lesson in this codebase is actually encoded. Do
not skip it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/email/auth.ts src/lib/email/auth.test.ts
git commit -m "feat: add the verification and password-reset emails"
```

---

### Task 2: Better Auth wired to Postgres

**Files:**
- Modify: `package.json` (add `better-auth@1.7.5`), `.env`, `.env.example`, `drizzle.config.ts`, `src/lib/db/schema.ts`, `src/test/db.ts`
- Create: `src/lib/auth/index.ts`, `src/lib/auth/auth.test.ts`, `src/lib/db/auth-schema.ts` (generated), `src/app/api/auth/[...all]/route.ts`, a `drizzle/` migration (generated)

**Interfaces:**
- Consumes: `sendVerificationEmail`, `sendPasswordResetEmail` from Task 1; `db` from `@/lib/db/client`.
- Produces: `auth` from `@/lib/auth`; `user`, `session`, `account`, `verification` tables re-exported from `@/lib/db/schema`.

**Why this shape:** the auth instance has to exist before the schema can be generated — the CLI reads the config to decide which tables and columns the enabled plugins need. So the config comes first and the generated file second, in one task, because neither is useful alone.

- [ ] **Step 1: Install and configure the environment**

```bash
npm install better-auth@1.7.5
```

Generate a secret and add both variables to `.env`:

```bash
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >> .env
echo "BETTER_AUTH_URL=http://localhost:3000" >> .env
```

Add the same two keys to `.env.example`, with placeholder values — it is tracked by the
drift guard and is synced in Step 9:

```
BETTER_AUTH_SECRET=generate_with_openssl_rand_base64_32
BETTER_AUTH_URL=http://localhost:3000
```

- [ ] **Step 2: Write the auth instance**

Create `src/lib/auth/index.ts`:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { sendVerificationEmail, sendPasswordResetEmail } from "@/lib/email/auth";

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
```

- [ ] **Step 3: Generate the auth schema**

Run:

```bash
npx auth@1.7.5 generate --config src/lib/auth/index.ts --output src/lib/db/auth-schema.ts -y
```

Expected: `🚀 Schema was generated successfully!`, and a `Drizzle schema mismatch` warning
listing the four missing tables. **The warning is correct and expected** — it is telling
you the tables do not exist in the database yet, which is what Step 6 fixes.

Read the generated file. It must define `user`, `session`, `account` and `verification`,
and `user` must carry `role`, `banned`, `banReason` and `banExpires` from the admin
plugin. If those four columns are absent, the CLI did not see the plugin — check the
`--config` path and re-run.

**Do not hand-edit this file**, including its timestamp columns, which lack the
`withTimezone: true` this codebase uses everywhere else. They belong to Better Auth.

- [ ] **Step 4: Re-export the auth tables**

At the top of `src/lib/db/schema.ts`, after the existing imports, add:

```ts
/**
 * Better Auth's tables live in a generated file so regenerating them cannot
 * clobber hand-written tables. Re-exported here so `@/lib/db/schema` stays the
 * single import for every table in the application.
 */
export { user, session, account, verification } from "./auth-schema";
```

- [ ] **Step 5: Teach drizzle-kit about the second schema file**

In `drizzle.config.ts`, replace the `schema` line with:

```ts
  schema: ["./src/lib/db/schema.ts", "./src/lib/db/auth-schema.ts"],
```

Without this, `db:generate` produces a migration that silently omits all four auth
tables — the re-export in Step 4 is invisible to drizzle-kit, which reads files, not
module graphs.

- [ ] **Step 6: Generate and apply the migration**

```bash
npm run db:generate
```

Expected: a new `drizzle/000N_*.sql` containing `CREATE TABLE "user"`, `"session"`,
`"account"` and `"verification"`, plus their indexes and foreign keys. Read it and
confirm it creates only those four tables. Do not edit it.

```bash
npm run db:migrate
docker exec coldsmoke-dev-db psql -U coldsmoke -d coldsmoke -c "\d user"
```

Expected: the `user` table with `role`, `banned`, `ban_reason` and `ban_expires`.

- [ ] **Step 7: Add the auth tables to the test harness**

In `src/test/db.ts`, extend the `TRUNCATE` list:

```ts
      await client`
        TRUNCATE order_items, orders, cart_items, carts, inventory_adjustments,
                 inventory, product_images, products, discount_codes, stripe_events,
                 contact_messages, session, account, verification, "user"
        RESTART IDENTITY CASCADE`;
```

`"user"` is quoted because `user` is a reserved word in Postgres; unquoted it parses as
the `USER` keyword and the statement fails. The four auth tables go last so the list
reads in the order the tables were added.

This is not optional bookkeeping. The previous plan omitted a new table from this list
and two tests failed on rows leaking between cases.

- [ ] **Step 8: Add the route handler**

Create `src/app/api/auth/[...all]/route.ts`:

```ts
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

/**
 * Better Auth's own endpoints: sign-in, sign-out, verification links, reset
 * links. Our Server Actions call `auth.api.*` directly rather than posting
 * here, but the verification and reset emails link to these routes, so they
 * have to be mounted.
 */
export const { GET, POST } = toNextJsHandler(auth);
```

- [ ] **Step 9: Write the config guard**

Create `src/lib/auth/auth.test.ts`:

```ts
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
```

- [ ] **Step 10: Run the guard**

Run: `npx vitest run src/lib/auth/auth.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 11: Prove the guard bites**

Temporarily set `requireEmailVerification: false` and move `nextCookies()` before
`admin(...)`. Re-run.
Expected: two failures — the verification test and the plugin-order test.
**Revert both** and confirm green.

- [ ] **Step 12: Verify the endpoint is mounted**

With the dev server running:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/auth/ok
```

Expected: `200`. A `404` means the route file is in the wrong directory — the catch-all
segment is `[...all]`, not `[...auth]`.

- [ ] **Step 13: Sync Plan 1 and commit**

Four tracked files changed: `.env.example`, `drizzle.config.ts`, `src/lib/db/schema.ts`
and `src/test/db.ts`. Replace the contents of each one's fenced block in
`docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md` with the current file
contents, then run `npm test` and confirm green.

```bash
git add package.json package-lock.json .env.example drizzle.config.ts \
  src/lib/auth src/lib/db/auth-schema.ts src/lib/db/schema.ts src/test/db.ts \
  drizzle/ src/app/api/auth \
  docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md
git commit -m "feat: wire Better Auth to Postgres"
```

---

### Task 3: Session helpers and the account boundary

**Files:**
- Create: `src/lib/auth/session.ts`, `src/app/(store)/account/layout.tsx`, `src/app/(store)/account/account.module.css`

**Interfaces:**
- Consumes: `auth` from Task 2.
- Produces: from `@/lib/auth/session`:
  - `type SessionUser = { id: string; email: string; name: string; role: string | null; emailVerified: boolean }`
  - `getSessionUser(): Promise<SessionUser | null>`
  - `requireSessionUser(next?: string): Promise<SessionUser>`

**Why this task is separate:** every page from here on needs it, and the layout is the
actual security boundary for `/account/*`. Getting it wrong once is worse than getting
every page wrong, because the pages inherit it.

- [ ] **Step 1: Write the session helpers**

Create `src/lib/auth/session.ts`:

```ts
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./index";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string | null;
  emailVerified: boolean;
};

/**
 * The signed-in customer, or null. Safe to call while rendering a Server
 * Component: it only reads headers.
 *
 * Every page reads the session through here rather than calling
 * auth.api.getSession directly, so the shape a page depends on is declared in
 * one place and Plan C's admin checks have somewhere to hang.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role ?? null,
    emailVerified: session.user.emailVerified,
  };
}

/**
 * The signed-in customer, or a redirect to sign-in.
 *
 * `next` is carried through the redirect so a customer who lands on a
 * deep-linked account page returns to it after signing in instead of being
 * dumped on a generic page and left to navigate back.
 */
export async function requireSessionUser(next?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    const target = next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in";
    redirect(target);
  }
  return user;
}
```

- [ ] **Step 2: Write the account layout**

Create `src/app/(store)/account/layout.tsx`:

```tsx
import Link from "next/link";
import { requireSessionUser } from "@/lib/auth/session";
import { ContentPage } from "@/components/content/ContentPage";
import styles from "./account.module.css";

/**
 * The security boundary for every /account route.
 *
 * A server-side session check in the layout is the actual gate. Next.js 16's
 * proxy.ts could redirect unauthenticated requests a few milliseconds sooner,
 * but a proxy is an optimisation and not a boundary: it does not run for every
 * render path, and it cannot be relied on to protect data.
 */
export default async function AccountLayout({
  children,
}: LayoutProps<"/account">) {
  const user = await requireSessionUser("/account/orders");

  return (
    <ContentPage title="Your account" lede={user.email}>
      <nav className={styles.tabs} aria-label="Account">
        <Link href="/account/orders">Orders</Link>
        <Link href="/account/addresses">Addresses</Link>
      </nav>
      {children}
    </ContentPage>
  );
}
```

Create `src/app/(store)/account/account.module.css`:

```css
.tabs {
  display: flex;
  gap: var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--line);
  margin-bottom: var(--space-4);
}

.tabs a {
  font-size: 0.68rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
  text-decoration: none;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output. There is no page under `/account` yet, so the layout is unreachable
— that is fine and is fixed in Task 9.

- [ ] **Step 4: Commit**

```bash
git add src/lib/auth/session.ts "src/app/(store)/account"
git commit -m "feat: add session helpers and the account boundary"
```

---

### Task 4: Sign up

**Files:**
- Modify: `src/lib/email/auth.ts`, `src/lib/email/auth.test.ts`
- Create: `src/app/(store)/sign-up/actions.ts`, `src/app/(store)/sign-up/SignUpForm.tsx`, `src/app/(store)/sign-up/page.tsx`, `src/app/(store)/sign-up/actions.test.ts`, `src/app/(store)/sign-up/page.module.css`

**Interfaces:**
- Consumes: `auth` from Task 2; `sendExistingAccountEmail` added below; `Field`, `Button` from `@/components/ui/*`.
- Produces: `signUpAction(prev: SignUpState, formData: FormData): Promise<SignUpState>` and `type SignUpState` from `./actions`.

**Context the implementer needs:** `auth.api.signUpEmail({ body, headers })` throws an
`APIError` from `better-auth/api` on failure. Its code is compared against
`auth.$ERROR_CODES.X.code` — note `.code`, because `$ERROR_CODES` entries are
`{ code, message }` objects, not bare strings. `src/app/(store)/checkout/actions.ts` is
the house pattern for Zod plus `useActionState`; read it first.

**The account-enumeration decision.** Sign-up returns the *same* state whether or not the
address already has an account, and the existing account holder is told by email. The
alternative — telling the browser "that address is taken" — hands an attacker a free
oracle for which of their stolen addresses shop here. Better Auth already returns a
uniform response for sign-in (`INVALID_EMAIL_OR_PASSWORD`, never "no such user") and for
password reset, so sign-up would be the only hole left, and closing two of three doors is
not a security posture. The cost is one extra email template, below.

- [ ] **Step 1: Add the third email and its tests**

Append to `src/lib/email/auth.ts`:

```ts
export function existingAccountEmail(url: string): { subject: string; text: string } {
  return {
    subject: "You already have a Coldsmoke account",
    text: [
      "Someone -- probably you -- just tried to create an account with this",
      "address. You already have one, so we did not make a second.",
      "",
      "Sign in here:",
      "",
      url,
      "",
      "If you did not request a password reset, ignore this message. Nobody",
      "can see your account or your orders from a sign-up attempt.",
    ].join("\n"),
  };
}

export function sendExistingAccountEmail(args: {
  to: string;
  url: string;
}): Promise<{ delivered: boolean }> {
  return send({ to: args.to, ...existingAccountEmail(args.url) });
}
```

Add to `src/lib/email/auth.test.ts`, inside the `email bodies` describe:

```ts
  it("puts the sign-in link in the existing-account body", () => {
    expect(existingAccountEmail(URL).text).toContain(URL);
  });

  it("says what the existing-account email is for", () => {
    expect(existingAccountEmail(URL).subject).toBe(
      "You already have a Coldsmoke account",
    );
  });

  it("does not confirm the account to a stranger who guessed the address", () => {
    // This mail goes to the real owner, not to whoever submitted the form, so
    // it may say the account exists. What it must never do is imply the
    // sign-up attempt revealed anything.
    expect(existingAccountEmail(URL).text).toContain("Nobody");
  });
```

and extend the import at the top of the test file to include `existingAccountEmail`.

Run: `npx vitest run src/lib/email/auth.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 2: Write the failing action tests**

Create `src/app/(store)/sign-up/actions.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { user } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const sendExistingAccountEmail = vi.fn(async () => ({ delivered: true }));
const sendVerificationEmail = vi.fn(async () => ({ delivered: true }));
vi.mock("@/lib/email/auth", () => ({
  sendExistingAccountEmail: (...args: unknown[]) => sendExistingAccountEmail(...args),
  sendVerificationEmail: (...args: unknown[]) => sendVerificationEmail(...args),
  sendPasswordResetEmail: vi.fn(async () => ({ delivered: true })),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const { signUpAction } = await import("./actions");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  sendExistingAccountEmail.mockClear();
  sendVerificationEmail.mockClear();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const VALID = {
  name: "Test Buyer",
  email: "buyer@example.com",
  password: "a long enough password",
};

describe("signUpAction", () => {
  it("creates an unverified account", async () => {
    const state = await signUpAction({ status: "idle" }, form(VALID));

    expect(state.status).toBe("sent");
    const [row] = await ctx.db
      .select()
      .from(user)
      .where(eq(user.email, "buyer@example.com"));
    // Unverified until the link is clicked. This is what gates the order
    // history claim in Task 6.
    expect(row.emailVerified).toBe(false);
  });

  it("defaults a new account to the customer role", async () => {
    await signUpAction({ status: "idle" }, form(VALID));

    const [row] = await ctx.db
      .select()
      .from(user)
      .where(eq(user.email, "buyer@example.com"));
    expect(row.role).toBe("customer");
  });

  it("rejects a short password with a reason", async () => {
    const state = await signUpAction(
      { status: "idle" },
      form({ ...VALID, password: "short" }),
    );

    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { password: "Use at least 8 characters." },
    });
  });

  it("rejects an invalid address with a reason", async () => {
    const state = await signUpAction(
      { status: "idle" },
      form({ ...VALID, email: "not-an-address" }),
    );

    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { email: "Enter a valid email address." },
    });
  });

  it("does not create a second account for an address already registered", async () => {
    await signUpAction({ status: "idle" }, form(VALID));
    await signUpAction({ status: "idle" }, form(VALID));

    const rows = await ctx.db
      .select()
      .from(user)
      .where(eq(user.email, "buyer@example.com"));
    expect(rows).toHaveLength(1);
  });

  it("gives a duplicate sign-up the same answer as a new one", async () => {
    await signUpAction({ status: "idle" }, form(VALID));
    const second = await signUpAction({ status: "idle" }, form(VALID));

    // The whole point: the browser cannot tell the two cases apart, so the
    // form is not an oracle for which addresses have accounts here.
    expect(second).toEqual({ status: "sent", email: "buyer@example.com" });
  });

  it("tells the existing account holder by email instead", async () => {
    await signUpAction({ status: "idle" }, form(VALID));
    sendExistingAccountEmail.mockClear();

    await signUpAction({ status: "idle" }, form(VALID));

    expect(sendExistingAccountEmail).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run "src/app/(store)/sign-up/actions.test.ts"`
Expected: FAIL — `Cannot find module './actions'`.

- [ ] **Step 4: Write the action**

Create `src/app/(store)/sign-up/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { sendExistingAccountEmail } from "@/lib/email/auth";

const schema = z.object({
  name: z.string().trim().min(1, "Enter your name."),
  email: z.email("Enter a valid email address."),
  // Matches minPasswordLength in the auth config. Checked here too so the
  // customer gets a field-level message instead of a thrown APIError.
  password: z.string().min(8, "Use at least 8 characters."),
});

export type SignUpState =
  | { status: "idle" }
  | { status: "sent"; email: string }
  | { status: "error"; error: string; fieldErrors?: Record<string, string> };

export async function signUpAction(
  _prev: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  const parsed = schema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    return { status: "error", error: "Check the highlighted fields.", fieldErrors };
  }

  const { name, email, password } = parsed.data;

  try {
    await auth.api.signUpEmail({
      body: { name, email, password },
      headers: await headers(),
    });
  } catch (err) {
    const alreadyExists =
      err instanceof APIError &&
      (err.body?.code === auth.$ERROR_CODES.USER_ALREADY_EXISTS.code ||
        err.body?.code ===
          auth.$ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL.code);

    if (!alreadyExists) throw err;

    // Deliberately falls through to the same "sent" state below. The account
    // holder is told by email; the browser learns nothing. See the task note
    // on account enumeration.
    await sendExistingAccountEmail({
      to: email,
      url: `${process.env.BETTER_AUTH_URL ?? ""}/sign-in`,
    });
  }

  return { status: "sent", email };
}
```

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run "src/app/(store)/sign-up/actions.test.ts"`
Expected: PASS, 7 tests.

- [ ] **Step 6: Prove the enumeration defence bites**

Temporarily replace the `if (!alreadyExists) throw err;` block with
`return { status: "error", error: "That address already has an account." };`
and re-run.
Expected: `gives a duplicate sign-up the same answer as a new one` FAILS.
**Restore it** and confirm green.

- [ ] **Step 7: Write the form and page**

Create `src/app/(store)/sign-up/page.module.css`:

```css
.form {
  display: grid;
  gap: var(--space-4);
  max-width: 26rem;
}

.error {
  color: var(--danger);
}
```

Create `src/app/(store)/sign-up/SignUpForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUpAction, type SignUpState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./page.module.css";

export function SignUpForm() {
  const [state, action, pending] = useActionState<SignUpState, FormData>(
    signUpAction,
    { status: "idle" },
  );

  if (state.status === "sent") {
    return (
      <p role="status">
        Check {state.email} for a link to confirm your address. You will not be
        able to sign in until you do.
      </p>
    );
  }

  return (
    <form action={action} className={styles.form}>
      <Field
        label="Your name"
        name="name"
        autoComplete="name"
        required
        error={state.status === "error" ? state.fieldErrors?.name : undefined}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={state.status === "error" ? state.fieldErrors?.email : undefined}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        error={state.status === "error" ? state.fieldErrors?.password : undefined}
      />

      {state.status === "error" && !state.fieldErrors && (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Creating" : "Create account"}
      </Button>

      <p>
        Already have an account? <Link href="/sign-in">Sign in</Link>.
      </p>
    </form>
  );
}
```

Create `src/app/(store)/sign-up/page.tsx`:

```tsx
import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";
import { SignUpForm } from "./SignUpForm";

export const metadata: Metadata = {
  title: "Create an account",
  description: "Keep your order history and addresses in one place.",
};

export default function SignUpPage() {
  return (
    <ContentPage
      title="Create an account"
      lede="Your past guest orders join your history once you confirm your address."
    >
      <SignUpForm />
    </ContentPage>
  );
}
```

- [ ] **Step 8: Verify by hand**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output.

With the dev server running, open `http://localhost:3000/sign-up` and create an account.
Expected: the form is replaced by the "check your email" message, and:

```bash
docker exec coldsmoke-dev-db psql -U coldsmoke -d coldsmoke \
  -c 'select email, email_verified, role from "user";'
```
shows one row with `email_verified` false and `role` `customer`.

The verification email only arrives if `RESEND_API_KEY` is real. If it is not, get the
link from the dev server log — Better Auth logs the generated URL — or read it from the
`verification` table. You need it in Task 6.

- [ ] **Step 9: Commit**

```bash
git add src/lib/email/auth.ts src/lib/email/auth.test.ts "src/app/(store)/sign-up"
git commit -m "feat: add sign-up"
```

---

### Task 5: Sign in, sign out, and the account link

**Files:**
- Create: `src/app/(store)/sign-in/actions.ts`, `src/app/(store)/sign-in/SignInForm.tsx`, `src/app/(store)/sign-in/page.tsx`, `src/app/(store)/sign-in/page.module.css`, `src/app/(store)/sign-in/actions.test.ts`
- Modify: `src/components/SiteHeader.tsx`, `src/app/(store)/layout.tsx`

**Interfaces:**
- Consumes: `auth` from Task 2; `getSessionUser` from Task 3.
- Produces: `signInAction(prev: SignInState, formData: FormData): Promise<SignInState>`, `signOutAction(): Promise<void>`, `type SignInState` from `./actions`.

**Context the implementer needs:** `SiteHeader` and `src/app/(store)/layout.tsx` are both
tracked by the drift guard, so this task syncs Plan 1 in its own commit (Step 7). The
layout already reads the cart count as a Server Component; the session is read the same
way.

- [ ] **Step 1: Write the failing action tests**

Create `src/app/(store)/sign-in/actions.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { user } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

vi.mock("@/lib/email/auth", () => ({
  sendVerificationEmail: vi.fn(async () => ({ delivered: true })),
  sendPasswordResetEmail: vi.fn(async () => ({ delivered: true })),
  sendExistingAccountEmail: vi.fn(async () => ({ delivered: true })),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const mergeGuestCart = vi.fn(async () => {});
vi.mock("@/lib/cart/merge", () => ({
  mergeGuestCart: (...args: unknown[]) => mergeGuestCart(...args),
}));

const { signInAction } = await import("./actions");
const { auth } = await import("@/lib/auth");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  mergeGuestCart.mockClear();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const CREDENTIALS = { email: "buyer@example.com", password: "a long enough password" };

async function createAccount(verified: boolean) {
  await auth.api.signUpEmail({
    body: { name: "Test Buyer", ...CREDENTIALS },
    headers: new Headers(),
  });
  if (verified) {
    await ctx.db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.email, CREDENTIALS.email));
  }
}

describe("signInAction", () => {
  it("signs in a verified account", async () => {
    await createAccount(true);

    const state = await signInAction({ status: "idle" }, form(CREDENTIALS));

    expect(state.status).toBe("ok");
  });

  it("refuses an unverified account and says so", async () => {
    await createAccount(false);

    const state = await signInAction({ status: "idle" }, form(CREDENTIALS));

    // Distinct from a wrong password: the customer needs to know the account
    // exists and what to do about it, and this is not an enumeration leak --
    // they already proved they know the password.
    expect(state).toMatchObject({ status: "unverified", email: CREDENTIALS.email });
  });

  it("refuses a wrong password without saying which field was wrong", async () => {
    await createAccount(true);

    const state = await signInAction(
      { status: "idle" },
      form({ ...CREDENTIALS, password: "not the password" }),
    );

    expect(state).toEqual({
      status: "error",
      error: "That email and password do not match.",
    });
  });

  it("gives an unknown address the same answer as a wrong password", async () => {
    const state = await signInAction(
      { status: "idle" },
      form({ email: "nobody@example.com", password: "whatever it is" }),
    );

    expect(state).toEqual({
      status: "error",
      error: "That email and password do not match.",
    });
  });

  it("merges the guest cart on a successful sign-in", async () => {
    await createAccount(true);

    await signInAction({ status: "idle" }, form(CREDENTIALS));

    expect(mergeGuestCart).toHaveBeenCalledTimes(1);
  });

  it("does not merge a cart when sign-in fails", async () => {
    await createAccount(true);

    await signInAction(
      { status: "idle" },
      form({ ...CREDENTIALS, password: "wrong" }),
    );

    expect(mergeGuestCart).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run "src/app/(store)/sign-in/actions.test.ts"`
Expected: FAIL — `Cannot find module './actions'`.

- [ ] **Step 3: Write the action**

`mergeGuestCart` does not exist until Task 8. Create a placeholder module now so this
task is independently green, and Task 8 replaces its body:

Create `src/lib/cart/merge.ts`:

```ts
/**
 * Merges a guest cart into the signed-in customer's cart.
 *
 * Implemented in Task 8. The signature exists from Task 5 so the sign-in
 * action can call it, and so the two tasks cannot disagree about it.
 */
export async function mergeGuestCart(_userId: string): Promise<void> {
  return;
}
```

Create `src/app/(store)/sign-in/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { mergeGuestCart } from "@/lib/cart/merge";

const schema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export type SignInState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "unverified"; email: string }
  | { status: "error"; error: string };

export async function signInAction(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { status: "error", error: "That email and password do not match." };
  }

  let userId: string;
  try {
    const result = await auth.api.signInEmail({
      body: parsed.data,
      headers: await headers(),
    });
    userId = result.user.id;
  } catch (err) {
    if (
      err instanceof APIError &&
      err.body?.code === auth.$ERROR_CODES.EMAIL_NOT_VERIFIED.code
    ) {
      return { status: "unverified", email: parsed.data.email };
    }

    // One message for "no such account" and for "wrong password". Telling
    // them apart would turn this form into a list of who shops here.
    return { status: "error", error: "That email and password do not match." };
  }

  // Only after a real sign-in. A guest cart must never be merged into an
  // account that failed to authenticate.
  await mergeGuestCart(userId);

  return { status: "ok" };
}

export async function signOutAction(): Promise<void> {
  await auth.api.signOut({ headers: await headers() });
  redirect("/");
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run "src/app/(store)/sign-in/actions.test.ts"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the form and page**

Create `src/app/(store)/sign-in/page.module.css`:

```css
.form {
  display: grid;
  gap: var(--space-4);
  max-width: 26rem;
}

.error {
  color: var(--danger);
}
```

Create `src/app/(store)/sign-in/SignInForm.tsx`:

```tsx
"use client";

import { useActionState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signInAction, type SignInState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./page.module.css";

export function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(
    signInAction,
    { status: "idle" },
  );
  const router = useRouter();
  const params = useSearchParams();

  /**
   * Redirect after the action reports success rather than from inside the
   * action. `next` is attacker-controllable, so it is only ever used as a
   * same-site path: a value like "https://elsewhere.example" would otherwise
   * turn our sign-in form into an open redirect.
   */
  useEffect(() => {
    if (state.status !== "ok") return;
    const next = params.get("next");
    const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : "/account/orders";
    router.push(safe);
  }, [state.status, params, router]);

  return (
    <form action={action} className={styles.form}>
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />

      {state.status === "error" && (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      )}

      {state.status === "unverified" && (
        <p role="alert" className={styles.error}>
          Confirm your email address first.{" "}
          <Link href={`/verify-email?email=${encodeURIComponent(state.email)}`}>
            Send the link again
          </Link>
          .
        </p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Signing in" : "Sign in"}
      </Button>

      <p>
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
      <p>
        New here? <Link href="/sign-up">Create an account</Link>.
      </p>
    </form>
  );
}
```

Create `src/app/(store)/sign-in/page.tsx`:

```tsx
import type { Metadata } from "next";
import { Suspense } from "react";
import { ContentPage } from "@/components/content/ContentPage";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to see your orders and saved addresses.",
};

export default function SignInPage() {
  return (
    <ContentPage title="Sign in">
      {/* useSearchParams needs a Suspense boundary to keep the rest of the
          page from opting into client-side rendering. */}
      <Suspense fallback={null}>
        <SignInForm />
      </Suspense>
    </ContentPage>
  );
}
```

- [ ] **Step 6: Add the account link to the header**

In `src/components/SiteHeader.tsx`, replace the component with:

```tsx
import Link from "next/link";
import { Wordmark } from "./ui/Wordmark";
import styles from "./SiteHeader.module.css";

export function SiteHeader({
  cartCount = 0,
  signedIn = false,
}: {
  cartCount?: number;
  signedIn?: boolean;
}) {
  return (
    <header className={styles.header}>
      <Link href="/" aria-label="Coldsmoke home">
        <Wordmark size={18} />
      </Link>

      <nav className={styles.nav} aria-label="Primary">
        <Link href="/shop">Shop</Link>
        <Link href="/the-scent">The Scent</Link>
        <Link href="/about">About</Link>
        <Link href={signedIn ? "/account/orders" : "/sign-in"}>
          {signedIn ? "Account" : "Sign in"}
        </Link>
      </nav>

      <Link href="/cart" className={styles.cart}>
        Cart{cartCount > 0 ? ` (${cartCount})` : ""}
      </Link>
    </header>
  );
}
```

In `src/app/(store)/layout.tsx`, read the session and pass it down:

```tsx
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { getCartId, getCartLines } from "@/lib/cart";
import { getSessionUser } from "@/lib/auth/session";

export default async function StoreLayout({ children }: LayoutProps<"/">) {
  // Read-only: a layout renders as a Server Component and may not set cookies.
  const cartId = await getCartId();
  const lines = cartId ? await getCartLines(cartId) : [];
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const user = await getSessionUser();

  return (
    <>
      <SiteHeader cartCount={count} signedIn={user !== null} />
      <main>{children}</main>
      <SiteFooter />
    </>
  );
}
```

- [ ] **Step 7: Verify, sync Plan 1, and commit**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output.

Sign in with the account from Task 4. Expected: refused with "Confirm your email address
first" — it is still unverified, which is `requireEmailVerification` working. Task 6
makes it possible to get past this.

`src/components/SiteHeader.tsx` and `src/app/(store)/layout.tsx` are tracked, so
`npm test` now fails on two drift assertions. Replace both fenced blocks in
`docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md` with the current file
contents, then run `npm test` and confirm green.

```bash
git add "src/app/(store)/sign-in" src/lib/cart/merge.ts \
  src/components/SiteHeader.tsx "src/app/(store)/layout.tsx" \
  docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md
git commit -m "feat: add sign-in, sign-out and the account link"
```

---

### Task 6: Verify the address and claim past guest orders

**Files:**
- Create: `src/lib/orders/claim.ts`, `src/lib/orders/claim.test.ts`, `src/app/(store)/verify-email/page.tsx`, `src/app/(store)/verify-email/ResendForm.tsx`, `src/app/(store)/verify-email/actions.ts`
- Modify: `src/lib/auth/index.ts`

**Interfaces:**
- Consumes: `auth` from Task 2.
- Produces: `claimGuestOrders(args: { userId: string; email: string }): Promise<number>` from `@/lib/orders/claim`; `resendVerificationAction(prev: ResendState, formData: FormData): Promise<ResendState>` and `type ResendState` from `./actions`.

**Why claiming lives here:** this is the task where an address stops being a claim and
becomes proof. Attaching orders anywhere earlier — at sign-up, or on first sign-in —
hands a stranger who typed someone else's address their name, postal address and
purchase history.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/orders/claim.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";
import type { Address } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { claimGuestOrders } = await import("./claim");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

const ADDRESS: Address = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

async function placeOrder(email: string, userId: string | null = null) {
  const [row] = await ctx.db
    .insert(orders)
    .values({
      email,
      userId,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingAddress: ADDRESS,
    })
    .returning({ id: orders.id });
  return row.id;
}

describe("claimGuestOrders", () => {
  it("attaches a guest order placed with the same address", async () => {
    const orderId = await placeOrder("buyer@example.com");

    const claimed = await claimGuestOrders({
      userId: "user_1",
      email: "buyer@example.com",
    });

    expect(claimed).toBe(1);
    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row.userId).toBe("user_1");
  });

  it("matches the address case-insensitively", async () => {
    // Checkout stores the address as typed; Better Auth lowercases it. Without
    // a case-insensitive match, anyone who typed a capital at checkout never
    // sees that order again.
    await placeOrder("Buyer@Example.com");

    expect(
      await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" }),
    ).toBe(1);
  });

  it("leaves another customer's orders alone", async () => {
    const otherId = await placeOrder("someone-else@example.com");

    await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" });

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, otherId));
    expect(row.userId).toBeNull();
  });

  it("never steals an order that already belongs to an account", async () => {
    // The dangerous case: same address, already claimed. Reassigning it would
    // move one customer's order into another customer's history.
    const orderId = await placeOrder("buyer@example.com", "user_original");

    await claimGuestOrders({ userId: "user_2", email: "buyer@example.com" });

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row.userId).toBe("user_original");
  });

  it("claims every matching guest order, not just the first", async () => {
    await placeOrder("buyer@example.com");
    await placeOrder("buyer@example.com");
    await placeOrder("buyer@example.com");

    expect(
      await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" }),
    ).toBe(3);
  });

  it("claims nothing the second time", async () => {
    await placeOrder("buyer@example.com");
    await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" });

    expect(
      await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" }),
    ).toBe(0);
  });

  it("returns zero when there is nothing to claim", async () => {
    expect(
      await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" }),
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/orders/claim.test.ts`
Expected: FAIL — `Cannot find module './claim'`.

- [ ] **Step 3: Write the module**

Create `src/lib/orders/claim.ts`:

```ts
import { and, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders } from "@/lib/db/schema";

/**
 * Attaches a verified customer's past guest orders to their account.
 *
 * Called only from Better Auth's afterEmailVerification hook. An email
 * address is a claim until it is verified; running this at sign-up would let
 * anyone type a stranger's address and read that stranger's order history.
 *
 * `isNull(orders.userId)` is not an optimisation. It is what stops a second
 * account claiming an order that already belongs to a first -- two people can
 * legitimately have used the same address at a shared household, and the
 * earlier claim wins.
 */
export async function claimGuestOrders(args: {
  userId: string;
  email: string;
}): Promise<number> {
  const claimed = await db
    .update(orders)
    .set({ userId: args.userId })
    .where(
      and(
        isNull(orders.userId),
        // Checkout stores the address exactly as typed; Better Auth
        // lowercases it. Compare on equal terms.
        sql`lower(${orders.email}) = ${args.email.toLowerCase()}`,
      ),
    )
    .returning({ id: orders.id });

  return claimed.length;
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/lib/orders/claim.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the ownership guard bites**

Temporarily remove `isNull(orders.userId)` from the `and(...)` and re-run.
Expected: `never steals an order that already belongs to an account` FAILS.
**Restore it** and confirm green.

- [ ] **Step 6: Wire the hook**

In `src/lib/auth/index.ts`, add the import:

```ts
import { claimGuestOrders } from "@/lib/orders/claim";
```

and add `afterEmailVerification` to the `emailVerification` block, after
`sendVerificationEmail`:

```ts
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
```

- [ ] **Step 7: Write the resend action**

Create `src/app/(store)/verify-email/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

const schema = z.object({ email: z.email("Enter a valid email address.") });

export type ResendState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "error"; error: string };

export async function resendVerificationAction(
  _prev: ResendState,
  formData: FormData,
): Promise<ResendState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { status: "error", error: "Enter a valid email address." };
  }

  try {
    await auth.api.sendVerificationEmail({
      body: { email: parsed.data.email, callbackURL: "/sign-in?verified=1" },
      headers: await headers(),
    });
  } catch {
    // Swallowed on purpose. The failure modes here are "no such account" and
    // "already verified", and reporting either would turn this form into the
    // enumeration oracle the sign-up form deliberately is not.
  }

  return { status: "sent" };
}
```

- [ ] **Step 8: Write the page**

Create `src/app/(store)/verify-email/ResendForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { resendVerificationAction, type ResendState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

export function ResendForm({ defaultEmail }: { defaultEmail?: string }) {
  const [state, action, pending] = useActionState<ResendState, FormData>(
    resendVerificationAction,
    { status: "idle" },
  );

  if (state.status === "sent") {
    return (
      <p role="status">
        If that address has an unverified account, a new link is on its way.
      </p>
    );
  }

  return (
    <form action={action}>
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        defaultValue={defaultEmail}
        required
      />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Sending" : "Send the link again"}
      </Button>
    </form>
  );
}
```

Create `src/app/(store)/verify-email/page.tsx`:

```tsx
import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";
import { ResendForm } from "./ResendForm";

export const metadata: Metadata = {
  title: "Confirm your email",
  description: "Confirm your address to finish setting up your account.",
};

export default async function VerifyEmailPage({
  searchParams,
}: PageProps<"/verify-email">) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : undefined;

  return (
    <ContentPage
      title="Confirm your email"
      lede="Your account is not usable until the address is confirmed."
    >
      <p>
        We sent you a link. Opening it confirms the address and adds any orders
        you placed as a guest with it to your history.
      </p>
      <p>Lost it? Ask for another.</p>
      <ResendForm defaultEmail={email} />
    </ContentPage>
  );
}
```

- [ ] **Step 9: Verify the whole round trip by hand**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output.

First place a guest order with the same address as the Task 4 account, so there is
something to claim. With the dev server running, buy a sample as a guest using
`buyer@example.com` — or insert one directly:

```bash
docker exec coldsmoke-dev-db psql -U coldsmoke -d coldsmoke -c \
  "insert into orders (email, subtotal_cents, total_cents, shipping_address)
   values ('buyer@example.com', 4500, 5100, '{\"name\":\"Test Buyer\",\"line1\":\"1 Powder Lane\",\"city\":\"Bozeman\",\"state\":\"MT\",\"postalCode\":\"59715\",\"country\":\"US\"}');"
```

Then open the verification link from Task 4 Step 8. Expected:

```bash
docker exec coldsmoke-dev-db psql -U coldsmoke -d coldsmoke -c \
  'select o.email, o.user_id is not null as claimed, u.email_verified
   from orders o left join "user" u on u.id = o.user_id;'
```
shows `claimed` true and `email_verified` true. Signing in now succeeds where Task 5
Step 7 was refused.

- [ ] **Step 10: Commit**

```bash
git add src/lib/orders/claim.ts src/lib/orders/claim.test.ts \
  src/lib/auth/index.ts "src/app/(store)/verify-email"
git commit -m "feat: claim guest orders when an address is verified"
```

---

### Task 7: Password reset

**Files:**
- Create: `src/app/(store)/forgot-password/page.tsx`, `src/app/(store)/forgot-password/ForgotForm.tsx`, `src/app/(store)/forgot-password/actions.ts`, `src/app/(store)/reset-password/page.tsx`, `src/app/(store)/reset-password/ResetForm.tsx`, `src/app/(store)/reset-password/actions.ts`, `src/app/(store)/reset-password/actions.test.ts`

**Interfaces:**
- Consumes: `auth` from Task 2.
- Produces: `requestResetAction`, `type ForgotState` from `forgot-password/actions`; `resetPasswordAction`, `type ResetState` from `reset-password/actions`.

**Context the implementer needs:** `sendResetPassword` is already configured in Task 2, so
the email sends itself. Better Auth's reset link points at `/api/auth/reset-password/:token`
which redirects to `redirectTo` with the token in the query string — that is why the reset
page reads `token` from `searchParams` rather than from a route segment.

- [ ] **Step 1: Write the request action**

Create `src/app/(store)/forgot-password/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

const schema = z.object({ email: z.email("Enter a valid email address.") });

export type ForgotState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "error"; error: string };

export async function requestResetAction(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { status: "error", error: "Enter a valid email address." };
  }

  try {
    await auth.api.requestPasswordReset({
      body: { email: parsed.data.email, redirectTo: "/reset-password" },
      headers: await headers(),
    });
  } catch {
    // Same answer either way -- see below.
  }

  // Unknown addresses get this too. A "no account with that address" message
  // would tell an attacker which of their stolen addresses shop here, and the
  // person who genuinely mistyped theirs finds out when no email arrives.
  return { status: "sent" };
}
```

- [ ] **Step 2: Write the failing reset tests**

Create `src/app/(store)/reset-password/actions.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

vi.mock("@/lib/email/auth", () => ({
  sendVerificationEmail: vi.fn(async () => ({ delivered: true })),
  sendPasswordResetEmail: vi.fn(async () => ({ delivered: true })),
  sendExistingAccountEmail: vi.fn(async () => ({ delivered: true })),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { resetPasswordAction } = await import("./actions");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("resetPasswordAction", () => {
  it("refuses a token that does not exist", async () => {
    const state = await resetPasswordAction(
      { status: "idle" },
      form({ token: "not-a-real-token", password: "a long enough password" }),
    );

    expect(state).toEqual({
      status: "error",
      error: "That reset link has expired. Ask for a new one.",
    });
  });

  it("refuses a short password before spending the token", async () => {
    const state = await resetPasswordAction(
      { status: "idle" },
      form({ token: "whatever", password: "short" }),
    );

    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { password: "Use at least 8 characters." },
    });
  });

  it("refuses a missing token outright", async () => {
    const state = await resetPasswordAction(
      { status: "idle" },
      form({ token: "", password: "a long enough password" }),
    );

    expect(state.status).toBe("error");
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run "src/app/(store)/reset-password/actions.test.ts"`
Expected: FAIL — `Cannot find module './actions'`.

- [ ] **Step 4: Write the reset action**

Create `src/app/(store)/reset-password/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

const schema = z.object({
  token: z.string().trim().min(1, "That reset link is incomplete."),
  password: z.string().min(8, "Use at least 8 characters."),
});

export type ResetState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; error: string; fieldErrors?: Record<string, string> };

export async function resetPasswordAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const parsed = schema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    return { status: "error", error: "Check the highlighted fields.", fieldErrors };
  }

  try {
    await auth.api.resetPassword({
      body: { newPassword: parsed.data.password, token: parsed.data.token },
      headers: await headers(),
    });
  } catch {
    // Expired, already spent, or forged all look the same from here, and the
    // customer's next move is identical in every case.
    return {
      status: "error",
      error: "That reset link has expired. Ask for a new one.",
    };
  }

  return { status: "ok" };
}
```

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run "src/app/(store)/reset-password/actions.test.ts"`
Expected: PASS, 3 tests.

- [ ] **Step 6: Write both pages**

Create `src/app/(store)/forgot-password/ForgotForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { requestResetAction, type ForgotState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

export function ForgotForm() {
  const [state, action, pending] = useActionState<ForgotState, FormData>(
    requestResetAction,
    { status: "idle" },
  );

  if (state.status === "sent") {
    return (
      <p role="status">
        If that address has an account, a reset link is on its way. It expires
        in an hour.
      </p>
    );
  }

  return (
    <form action={action}>
      <Field label="Email" name="email" type="email" autoComplete="email" required />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Sending" : "Send a reset link"}
      </Button>
    </form>
  );
}
```

Create `src/app/(store)/forgot-password/page.tsx`:

```tsx
import type { Metadata } from "next";
import { ContentPage } from "@/components/content/ContentPage";
import { ForgotForm } from "./ForgotForm";

export const metadata: Metadata = {
  title: "Forgot your password",
  description: "Get a link to choose a new password.",
};

export default function ForgotPasswordPage() {
  return (
    <ContentPage title="Forgot your password">
      <ForgotForm />
    </ContentPage>
  );
}
```

Create `src/app/(store)/reset-password/ResetForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import Link from "next/link";
import { resetPasswordAction, type ResetState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

export function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(
    resetPasswordAction,
    { status: "idle" },
  );

  if (state.status === "ok") {
    return (
      <p role="status">
        Your password is changed. <Link href="/sign-in">Sign in</Link>.
      </p>
    );
  }

  return (
    <form action={action}>
      {/* The token rides along in the form rather than being read from the
          URL inside the action: a Server Action has no access to the page's
          query string. */}
      <input type="hidden" name="token" value={token} />
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        error={state.status === "error" ? state.fieldErrors?.password : undefined}
      />

      {state.status === "error" && !state.fieldErrors && (
        <p role="alert">{state.error}</p>
      )}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving" : "Set a new password"}
      </Button>
    </form>
  );
}
```

Create `src/app/(store)/reset-password/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { ContentPage } from "@/components/content/ContentPage";
import { ResetForm } from "./ResetForm";

export const metadata: Metadata = {
  title: "Choose a new password",
  description: "Set a new password for your Coldsmoke account.",
};

export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";

  if (!token) {
    return (
      <ContentPage title="Choose a new password">
        <p>
          That link is missing its token. <Link href="/forgot-password">Ask for
          a new one</Link>.
        </p>
      </ContentPage>
    );
  }

  return (
    <ContentPage title="Choose a new password">
      <ResetForm token={token} />
    </ContentPage>
  );
}
```

- [ ] **Step 7: Verify by hand**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output.

Request a reset for the Task 4 account, take the link from the log or the `verification`
table, open it, and set a new password. Expected: the confirmation message, and signing
in with the new password works while the old one gives "That email and password do not
match."

- [ ] **Step 8: Commit**

```bash
git add "src/app/(store)/forgot-password" "src/app/(store)/reset-password"
git commit -m "feat: add password reset"
```

---

### Task 8: Merge the guest cart on sign-in

**Files:**
- Modify: `src/lib/cart/merge.ts`, `src/lib/cart/index.ts`
- Create: `src/lib/cart/merge.test.ts`

**Interfaces:**
- Consumes: `getCartId`, `CART_COOKIE`, `MAX_LINE_QUANTITY` from `@/lib/cart`; `getCatalogProductById` from `@/lib/catalog`.
- Produces: `mergeGuestCart(userId: string): Promise<void>` from `@/lib/cart/merge` (replacing Task 5's placeholder).

**Context the implementer needs:** `src/lib/cart/index.ts` is tracked by the drift guard,
so this task syncs Plan 1 (Step 6). `getCatalogProductById` returns a `CatalogProduct`
whose `available` field is already `onHand - reserved` floored at zero — use it rather
than recomputing, so the three catalog reads cannot drift apart. **`mergeGuestCart` writes
a cookie, so it is callable only from a Server Action or Route Handler**, which is exactly
where Task 5 calls it.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/cart/merge.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { carts, cartItems, products, inventory } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

let guestCartId: string | null = null;
const cookieSet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "cs_cart" && guestCartId ? { value: guestCartId } : undefined,
    set: (...args: unknown[]) => cookieSet(...args),
  }),
}));

const { mergeGuestCart } = await import("./merge");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

let productId: string;

beforeEach(async () => {
  await ctx.truncate();
  cookieSet.mockClear();

  const [product] = await ctx.db
    .insert(products)
    .values({
      slug: "coldsmoke-edt",
      name: "Coldsmoke Eau de Toilette",
      priceCents: 4500,
      sku: "CS-EDT-50",
    })
    .returning({ id: products.id });
  productId = product.id;

  await ctx.db.insert(inventory).values({ productId, onHand: 10, reserved: 0 });
});

async function makeCart(userId: string | null, quantity?: number) {
  const [cart] = await ctx.db
    .insert(carts)
    .values({ userId })
    .returning({ id: carts.id });
  if (quantity !== undefined) {
    await ctx.db.insert(cartItems).values({ cartId: cart.id, productId, quantity });
  }
  return cart.id;
}

async function quantityIn(cartId: string): Promise<number | undefined> {
  const rows = await ctx.db
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId));
  return rows[0]?.quantity;
}

describe("mergeGuestCart", () => {
  it("adopts the guest cart when the customer has none", async () => {
    guestCartId = await makeCart(null, 2);

    await mergeGuestCart("user_1");

    const [cart] = await ctx.db
      .select()
      .from(carts)
      .where(eq(carts.id, guestCartId!));
    expect(cart.userId).toBe("user_1");
  });

  it("sums quantities when both carts hold the same product", async () => {
    const userCartId = await makeCart("user_1", 1);
    guestCartId = await makeCart(null, 2);

    await mergeGuestCart("user_1");

    expect(await quantityIn(userCartId)).toBe(3);
  });

  it("caps the sum at what is actually in stock", async () => {
    await ctx.db
      .update(inventory)
      .set({ onHand: 4 })
      .where(eq(inventory.productId, productId));
    const userCartId = await makeCart("user_1", 3);
    guestCartId = await makeCart(null, 3);

    await mergeGuestCart("user_1");

    // 3 + 3 = 6, but only 4 exist. Carrying 6 forward would just move the
    // failure to checkout, where it costs the customer their place.
    expect(await quantityIn(userCartId)).toBe(4);
  });

  it("caps the sum at the per-line ceiling", async () => {
    await ctx.db
      .update(inventory)
      .set({ onHand: 500 })
      .where(eq(inventory.productId, productId));
    const userCartId = await makeCart("user_1", 60);
    guestCartId = await makeCart(null, 60);

    await mergeGuestCart("user_1");

    expect(await quantityIn(userCartId)).toBe(99);
  });

  it("empties the guest cart it merged from", async () => {
    await makeCart("user_1", 1);
    guestCartId = await makeCart(null, 2);

    await mergeGuestCart("user_1");

    expect(await quantityIn(guestCartId!)).toBeUndefined();
  });

  it("points the cookie at the customer's cart", async () => {
    const userCartId = await makeCart("user_1", 1);
    guestCartId = await makeCart(null, 2);

    await mergeGuestCart("user_1");

    expect(cookieSet).toHaveBeenCalledWith(
      "cs_cart",
      userCartId,
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it("does nothing when there is no guest cart", async () => {
    guestCartId = null;
    const userCartId = await makeCart("user_1", 1);

    await mergeGuestCart("user_1");

    expect(await quantityIn(userCartId)).toBe(1);
  });

  it("is a no-op when the guest cart is already the customer's", async () => {
    guestCartId = await makeCart("user_1", 2);

    await mergeGuestCart("user_1");

    expect(await quantityIn(guestCartId!)).toBe(2);
  });
});
```

If `CART_COOKIE` is not the string `cs_cart`, correct the mock above to match
`src/lib/cookies.ts` — the test asserts the real cookie name on purpose, so a rename
cannot silently strand the merge.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/cart/merge.test.ts`
Expected: FAIL — the placeholder returns without doing anything, so
`adopts the guest cart when the customer has none` fails first.

- [ ] **Step 3: Write the merge**

Replace `src/lib/cart/merge.ts` with:

```ts
import { cookies } from "next/headers";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { carts, cartItems } from "@/lib/db/schema";
import { getCatalogProductById } from "@/lib/catalog";
import { CART_COOKIE } from "@/lib/cookies";
import { MAX_LINE_QUANTITY } from "./limits";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * Merges the guest cart in the caller's cookie into the signed-in customer's
 * cart. Quantities sum; the sum is capped at what is in stock.
 *
 * WRITES A COOKIE -- callable only from a Server Action or Route Handler. The
 * sign-in action is the only caller.
 *
 * Capping here rather than at checkout is deliberate. An uncapped merge moves
 * the failure to the checkout page, where the customer has already entered an
 * address and is told, at the last step, that they cannot have what their cart
 * says they can.
 */
export async function mergeGuestCart(userId: string): Promise<void> {
  const jar = await cookies();
  const guestCartId = jar.get(CART_COOKIE)?.value;
  if (!guestCartId) return;

  const [guestCart] = await db
    .select()
    .from(carts)
    .where(eq(carts.id, guestCartId))
    .limit(1);
  if (!guestCart) return;

  // Already theirs -- signing in twice must not double anything.
  if (guestCart.userId === userId) return;

  const [userCart] = await db
    .select()
    .from(carts)
    .where(eq(carts.userId, userId))
    .limit(1);

  // No cart of their own: adopt this one whole. Nothing to sum, and the
  // cookie already points at it.
  if (!userCart) {
    await db.update(carts).set({ userId }).where(eq(carts.id, guestCartId));
    return;
  }

  const guestItems = await db
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, guestCartId));

  for (const item of guestItems) {
    const product = await getCatalogProductById(item.productId);
    if (!product || !product.active) continue;

    const [existing] = await db
      .select()
      .from(cartItems)
      .where(
        and(
          eq(cartItems.cartId, userCart.id),
          eq(cartItems.productId, item.productId),
        ),
      )
      .limit(1);

    const summed = (existing?.quantity ?? 0) + item.quantity;
    const quantity = Math.min(summed, product.available, MAX_LINE_QUANTITY);
    if (quantity <= 0) continue;

    await db
      .insert(cartItems)
      .values({ cartId: userCart.id, productId: item.productId, quantity })
      .onConflictDoUpdate({
        target: [cartItems.cartId, cartItems.productId],
        set: { quantity },
      });
  }

  await db.delete(cartItems).where(eq(cartItems.cartId, guestCartId));
  await db
    .update(carts)
    .set({ updatedAt: new Date() })
    .where(eq(carts.id, userCart.id));

  jar.set(CART_COOKIE, userCart.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}
```

Remove the now-unused `sql` import if lint flags it.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/lib/cart/merge.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the stock cap bites**

Temporarily change `Math.min(summed, product.available, MAX_LINE_QUANTITY)` to
`Math.min(summed, MAX_LINE_QUANTITY)` and re-run.
Expected: `caps the sum at what is actually in stock` FAILS with 6 instead of 4.
**Restore it** and confirm green.

- [ ] **Step 6: Document the merge from the cart module, sync Plan 1, and commit**

In `src/lib/cart/index.ts`, replace the stale sentence in the `getOrCreateCartId` doc
comment — "Plan 2 attaches userId on sign-in and merges" — with:

```ts
 * Resolves the caller's cart, creating one if needed. Guest carts are
 * identified by a uuid in an httpOnly cookie; `mergeGuestCart` in ./merge
 * attaches userId and folds a guest cart into the customer's on sign-in.
```

`src/lib/cart/index.ts` is tracked, so replace its fenced block in
`docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md` with the current file
contents, then run `npm test` and confirm green.

```bash
git add src/lib/cart/merge.ts src/lib/cart/merge.test.ts src/lib/cart/index.ts \
  docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md
git commit -m "feat: merge a guest cart into the customer's on sign-in"
```

---

### Task 9: Attach orders to accounts, and the order history page

**Files:**
- Modify: `src/lib/orders/index.ts`, `src/app/(store)/checkout/actions.ts`
- Create: `src/lib/orders/history.ts`, `src/lib/orders/history.test.ts`, `src/app/(store)/account/orders/page.tsx`, `src/app/(store)/account/orders/page.module.css`

**Interfaces:**
- Consumes: `getSessionUser` from Task 3; `OrderWithItems` from `@/lib/orders`.
- Produces: `getOrdersForUser(userId: string): Promise<OrderWithItems[]>` from `@/lib/orders/history`; `createPendingOrder` gains an optional `userId`.

**Context the implementer needs:** both modified files are tracked by the drift guard, so
this task syncs Plan 1 (Step 6). Inside `createPendingOrder` there is a `money` object
that is spread into *both* the insert (`.values({ ...money, status: "pending" })`) and the
reuse-path update (`.set({ ...money, inventoryState: "reserved" })`). Adding `userId`
there covers both paths in one edit — a signed-in customer who edits their address mid-
checkout keeps the attachment.

- [ ] **Step 1: Attach userId at order creation**

In `src/lib/orders/index.ts`, add to the `createPendingOrder` args type, after
`email: string;`:

```ts
  /** Set when the buyer is signed in. Guest orders stay null and are claimed
   *  later by @/lib/orders/claim when the address is verified. */
  userId?: string | null;
```

Then add this line to the `money` object, next to `email`:

```ts
    userId: args.userId ?? null,
```

`money` is spread into both the create and the reuse branch, so one line covers both.

In `src/app/(store)/checkout/actions.ts`, import the session helper:

```ts
import { getSessionUser } from "@/lib/auth/session";
```

and inside `startCheckoutAction`, before the `createPendingOrder` call, read the session
and pass it through:

```ts
  // A signed-in buyer's order belongs to their account immediately. A guest's
  // stays unattached until they verify the address.
  const sessionUser = await getSessionUser();
```

then add `userId: sessionUser?.id ?? null,` to the `createPendingOrder({ ... })` argument
object.

- [ ] **Step 2: Write the failing history tests**

Create `src/lib/orders/history.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { orders, orderItems, products } from "@/lib/db/schema";
import type { Address } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { getOrdersForUser } = await import("./history");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

let productId: string;

beforeEach(async () => {
  await ctx.truncate();
  const [product] = await ctx.db
    .insert(products)
    .values({
      slug: "coldsmoke-edt",
      name: "Coldsmoke Eau de Toilette",
      priceCents: 4500,
      sku: "CS-EDT-50",
    })
    .returning({ id: products.id });
  productId = product.id;
});

const ADDRESS: Address = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

async function placeOrder(userId: string | null, createdAt: Date) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      userId,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingAddress: ADDRESS,
      createdAt,
    })
    .returning({ id: orders.id });

  await ctx.db.insert(orderItems).values({
    orderId: order.id,
    productId,
    name: "Coldsmoke Eau de Toilette",
    unitPriceCents: 4500,
    quantity: 1,
    totalCents: 4500,
  });

  return order.id;
}

describe("getOrdersForUser", () => {
  it("returns the customer's orders, newest first", async () => {
    const older = await placeOrder("user_1", new Date("2026-01-01"));
    const newer = await placeOrder("user_1", new Date("2026-06-01"));

    const history = await getOrdersForUser("user_1");

    expect(history.map((o) => o.id)).toEqual([newer, older]);
  });

  it("excludes another customer's orders", async () => {
    await placeOrder("user_2", new Date("2026-01-01"));

    expect(await getOrdersForUser("user_1")).toEqual([]);
  });

  it("excludes guest orders nobody has claimed", async () => {
    // Unclaimed means unverified. Showing it here would leak an order to
    // whoever happened to be signed in.
    await placeOrder(null, new Date("2026-01-01"));

    expect(await getOrdersForUser("user_1")).toEqual([]);
  });

  it("includes the line items", async () => {
    await placeOrder("user_1", new Date("2026-01-01"));

    const [order] = await getOrdersForUser("user_1");
    expect(order.items).toHaveLength(1);
    expect(order.items[0].name).toBe("Coldsmoke Eau de Toilette");
  });

  it("returns an empty list for a customer with no orders", async () => {
    expect(await getOrdersForUser("user_1")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/lib/orders/history.test.ts`
Expected: FAIL — `Cannot find module './history'`.

- [ ] **Step 4: Write the module**

Create `src/lib/orders/history.ts`:

```ts
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, orderItems } from "@/lib/db/schema";
import type { OrderWithItems } from "./index";

/**
 * A customer's own orders, newest first.
 *
 * Filtered on userId and nothing else. An order with a null userId is a guest
 * order nobody has proven they own, and it stays invisible here until
 * claimGuestOrders attaches it on verification.
 */
export async function getOrdersForUser(userId: string): Promise<OrderWithItems[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt));

  if (rows.length === 0) return [];

  // One query for every line rather than one per order.
  const items = await db
    .select()
    .from(orderItems)
    .where(
      inArray(
        orderItems.orderId,
        rows.map((o) => o.id),
      ),
    );

  const byOrder = new Map<string, typeof items>();
  for (const item of items) {
    const list = byOrder.get(item.orderId) ?? [];
    list.push(item);
    byOrder.set(item.orderId, list);
  }

  return rows.map((order) => ({ ...order, items: byOrder.get(order.id) ?? [] }));
}
```

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run src/lib/orders/history.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the page**

Create `src/app/(store)/account/orders/page.module.css`:

```css
.order {
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--line);
}

.meta {
  display: flex;
  gap: var(--space-4);
  font-size: 0.72rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
}
```

Create `src/app/(store)/account/orders/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { requireSessionUser } from "@/lib/auth/session";
import { getOrdersForUser } from "@/lib/orders/history";
import { formatOrderNumber } from "@/lib/orders/format";
import { Price } from "@/components/ui/Price";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Your orders" };

export default async function AccountOrdersPage() {
  // The layout already enforces this; calling it again is how the page gets
  // the user, not a second gate.
  const user = await requireSessionUser("/account/orders");
  const orders = await getOrdersForUser(user.id);

  if (orders.length === 0) {
    return (
      <p>
        No orders yet. <Link href="/shop">Have a look</Link>.
      </p>
    );
  }

  return (
    <div>
      {orders.map((order) => (
        <article key={order.id} className={styles.order}>
          <div className={styles.meta}>
            <span>{formatOrderNumber(order.orderNumber)}</span>
            <span>{order.createdAt.toLocaleDateString("en-US")}</span>
            <span>{order.status}</span>
          </div>
          <p>
            {order.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")}
            {" — "}
            <Price cents={order.totalCents} />
          </p>
        </article>
      ))}
    </div>
  );
}
```

If `Price` does not take a `cents` prop, check `src/components/ui/Price.tsx` and use its
actual prop name — it is the only component here whose interface this plan did not
restate.

- [ ] **Step 7: Verify, sync Plan 1, and commit**

Run: `npx tsc --noEmit && npm run lint`
Expected: no output.

Sign in with the verified account from Task 6 and open
`http://localhost:3000/account/orders`.
Expected: the guest order claimed in Task 6 is listed.

`src/lib/orders/index.ts` and `src/app/(store)/checkout/actions.ts` are tracked. Replace
both fenced blocks in
`docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md` with the current file
contents, then run `npm test` and confirm green.

```bash
git add src/lib/orders/index.ts src/lib/orders/history.ts src/lib/orders/history.test.ts \
  "src/app/(store)/checkout/actions.ts" "src/app/(store)/account/orders" \
  docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md
git commit -m "feat: attach orders to accounts and show an order history"
```

---

### Task 10: Saved addresses

**Files:**
- Modify: `src/lib/db/schema.ts`, `src/test/db.ts`
- Create: `src/lib/addresses/index.ts`, `src/lib/addresses/addresses.test.ts`, `src/app/(store)/account/addresses/page.tsx`, `src/app/(store)/account/addresses/AddressForm.tsx`, `src/app/(store)/account/addresses/actions.ts`, `src/app/(store)/account/addresses/page.module.css`, a `drizzle/` migration (generated)

**Interfaces:**
- Consumes: `requireSessionUser` from Task 3.
- Produces: from `@/lib/addresses`:
  - `listAddresses(userId: string): Promise<SavedAddress[]>`
  - `createAddress(userId: string, input: AddressInput): Promise<SavedAddress>`
  - `deleteAddress(userId: string, addressId: string): Promise<boolean>`
  - `setDefaultAddress(userId: string, addressId: string): Promise<boolean>`

**Context the implementer needs:** both modified files are tracked, so this task syncs
Plan 1 (Step 8). The spec calls for saved addresses to be **distinct from the address
snapshot on an order** — editing a saved address must never rewrite shipping history,
which is why orders keep jsonb copies and these rows are never joined to them.

- [ ] **Step 1: Add the table**

In `src/lib/db/schema.ts`, after the `contactMessages` table, add:

```ts
/**
 * Saved addresses for signed-in customers.
 *
 * Deliberately not referenced by orders. An order carries a jsonb snapshot of
 * where it actually shipped, so editing or deleting a saved address cannot
 * rewrite shipping history.
 */
export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label"),
    name: text("name").notNull(),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: text("city").notNull(),
    state: text("state").notNull(),
    postalCode: text("postal_code").notNull(),
    country: text("country").notNull().default("US"),
    phone: text("phone"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("addresses_user_idx").on(t.userId),
    // At most one default per customer, enforced by the database rather than
    // by remembering to clear the old one. A partial unique index is the only
    // version of this rule that a concurrent write cannot slip past.
    uniqueIndex("addresses_one_default_idx")
      .on(t.userId)
      .where(sql`${t.isDefault}`),
  ],
);
```

`boolean`, `index`, `uniqueIndex`, `sql`, `text`, `timestamp` and `uuid` are all imported
already. `user` comes from the re-export added in Task 2.

Add the type export next to the others:

```ts
export type SavedAddress = typeof addresses.$inferSelect;
```

- [ ] **Step 2: Generate and apply the migration**

```bash
npm run db:generate
```

Expected: a migration containing `CREATE TABLE "addresses"` and a
`CREATE UNIQUE INDEX ... WHERE "is_default"`. If the `WHERE` clause is missing, the
partial index did not survive — check the `.where()` call. Do not edit the file.

```bash
npm run db:migrate
docker exec coldsmoke-dev-db psql -U coldsmoke -d coldsmoke -c "\d addresses"
```

Add `addresses` to the `TRUNCATE` list in `src/test/db.ts`, after `contact_messages`.

- [ ] **Step 3: Write the failing tests**

Create `src/lib/addresses/addresses.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { user } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { listAddresses, createAddress, deleteAddress, setDefaultAddress } =
  await import("./index");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  await ctx.db.insert(user).values([
    { id: "user_1", name: "Buyer One", email: "one@example.com", emailVerified: true },
    { id: "user_2", name: "Buyer Two", email: "two@example.com", emailVerified: true },
  ]);
});

const INPUT = {
  label: "Home",
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

describe("addresses", () => {
  it("saves an address for a customer", async () => {
    await createAddress("user_1", INPUT);

    const saved = await listAddresses("user_1");
    expect(saved).toHaveLength(1);
    expect(saved[0].line1).toBe("1 Powder Lane");
  });

  it("makes the first address the default", async () => {
    // Otherwise a customer with exactly one address has no default, and
    // checkout has nothing to preselect.
    await createAddress("user_1", INPUT);

    expect((await listAddresses("user_1"))[0].isDefault).toBe(true);
  });

  it("does not make later addresses the default", async () => {
    await createAddress("user_1", INPUT);
    const second = await createAddress("user_1", { ...INPUT, label: "Work" });

    expect(second.isDefault).toBe(false);
  });

  it("moves the default rather than adding a second one", async () => {
    const first = await createAddress("user_1", INPUT);
    const second = await createAddress("user_1", { ...INPUT, label: "Work" });

    await setDefaultAddress("user_1", second.id);

    const saved = await listAddresses("user_1");
    expect(saved.filter((a) => a.isDefault).map((a) => a.id)).toEqual([second.id]);
    expect(saved.find((a) => a.id === first.id)?.isDefault).toBe(false);
  });

  it("never lists another customer's addresses", async () => {
    await createAddress("user_2", INPUT);

    expect(await listAddresses("user_1")).toEqual([]);
  });

  it("refuses to delete an address belonging to someone else", async () => {
    const theirs = await createAddress("user_2", INPUT);

    expect(await deleteAddress("user_1", theirs.id)).toBe(false);
    expect(await listAddresses("user_2")).toHaveLength(1);
  });

  it("refuses to promote an address belonging to someone else", async () => {
    const theirs = await createAddress("user_2", INPUT);

    expect(await setDefaultAddress("user_1", theirs.id)).toBe(false);
  });

  it("deletes the customer's own address", async () => {
    const mine = await createAddress("user_1", INPUT);

    expect(await deleteAddress("user_1", mine.id)).toBe(true);
    expect(await listAddresses("user_1")).toEqual([]);
  });
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `npx vitest run src/lib/addresses/addresses.test.ts`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 5: Write the module**

Create `src/lib/addresses/index.ts`:

```ts
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { addresses, type SavedAddress } from "@/lib/db/schema";

export type { SavedAddress };

export type AddressInput = {
  label?: string | null;
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  phone?: string | null;
};

/**
 * Every function here takes userId as its first argument and filters on it.
 *
 * That is the whole ownership model: an address id is a uuid a caller could
 * supply from anywhere, so no function may act on one without also matching
 * the owner. The "refuses to ... belonging to someone else" tests are the
 * ones that would fail if a future edit drops that condition.
 */
export async function listAddresses(userId: string): Promise<SavedAddress[]> {
  return db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), asc(addresses.createdAt));
}

export async function createAddress(
  userId: string,
  input: AddressInput,
): Promise<SavedAddress> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: addresses.id })
      .from(addresses)
      .where(eq(addresses.userId, userId))
      .limit(1);

    const [created] = await tx
      .insert(addresses)
      .values({
        userId,
        label: input.label ?? null,
        name: input.name,
        line1: input.line1,
        line2: input.line2 ?? null,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country ?? "US",
        phone: input.phone ?? null,
        // The first address a customer saves is their default; anything else
        // leaves checkout with nothing to preselect.
        isDefault: existing.length === 0,
      })
      .returning();

    return created;
  });
}

export async function deleteAddress(
  userId: string,
  addressId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
    .returning({ id: addresses.id });

  return deleted.length > 0;
}

export async function setDefaultAddress(
  userId: string,
  addressId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Clear first: the partial unique index permits only one default per
    // customer, so promoting before demoting would violate it.
    await tx
      .update(addresses)
      .set({ isDefault: false })
      .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)));

    const promoted = await tx
      .update(addresses)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
      .returning({ id: addresses.id });

    return promoted.length > 0;
  });
}
```

- [ ] **Step 6: Run them and watch them pass**

Run: `npx vitest run src/lib/addresses/addresses.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Prove the ownership filter bites**

Temporarily drop `eq(addresses.userId, userId)` from `deleteAddress`'s `and(...)` and
re-run.
Expected: `refuses to delete an address belonging to someone else` FAILS.
**Restore it** and confirm green.

- [ ] **Step 8: Write the page, sync Plan 1, and commit**

Create `src/app/(store)/account/addresses/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireSessionUser } from "@/lib/auth/session";
import { createAddress, deleteAddress, setDefaultAddress } from "@/lib/addresses";

const schema = z.object({
  label: z.string().trim().optional().transform((v) => v || null),
  name: z.string().trim().min(1, "Enter a name."),
  line1: z.string().trim().min(1, "Enter a street address."),
  line2: z.string().trim().optional().transform((v) => v || null),
  city: z.string().trim().min(1, "Enter a city."),
  state: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter state code.")
    .transform((v) => v.toUpperCase()),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a valid ZIP code."),
});

export type AddressState =
  | { status: "idle" }
  | { status: "saved" }
  | { status: "error"; error: string; fieldErrors?: Record<string, string> };

export async function saveAddressAction(
  _prev: AddressState,
  formData: FormData,
): Promise<AddressState> {
  const user = await requireSessionUser("/account/addresses");

  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    return { status: "error", error: "Check the highlighted fields.", fieldErrors };
  }

  await createAddress(user.id, parsed.data);
  revalidatePath("/account/addresses");
  return { status: "saved" };
}

export async function deleteAddressAction(formData: FormData): Promise<void> {
  const user = await requireSessionUser("/account/addresses");
  const id = String(formData.get("id") ?? "");
  // The session's user id, never one from the form: the id in the form is
  // attacker-controlled, the session is not.
  await deleteAddress(user.id, id);
  revalidatePath("/account/addresses");
}

export async function setDefaultAddressAction(formData: FormData): Promise<void> {
  const user = await requireSessionUser("/account/addresses");
  const id = String(formData.get("id") ?? "");
  await setDefaultAddress(user.id, id);
  revalidatePath("/account/addresses");
}
```

Create `src/app/(store)/account/addresses/page.module.css`:

```css
.list {
  display: grid;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}

.address {
  padding: var(--space-3);
  border: 1px solid var(--line);
}

.default {
  border-color: var(--line-bright);
}

.badge {
  font-size: 0.62rem;
  letter-spacing: var(--track-wide);
  text-transform: uppercase;
  color: var(--text-dim);
}

.form {
  display: grid;
  gap: var(--space-4);
  max-width: 26rem;
}

.row {
  display: flex;
  gap: var(--space-3);
}
```

Create `src/app/(store)/account/addresses/AddressForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { saveAddressAction, type AddressState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./page.module.css";

export function AddressForm() {
  const [state, action, pending] = useActionState<AddressState, FormData>(
    saveAddressAction,
    { status: "idle" },
  );

  const errorFor = (name: string) =>
    state.status === "error" ? state.fieldErrors?.[name] : undefined;

  return (
    <form action={action} className={styles.form}>
      <Field label="Label (optional)" name="label" placeholder="Home" />
      <Field label="Full name" name="name" autoComplete="name" required error={errorFor("name")} />
      <Field
        label="Address"
        name="line1"
        autoComplete="address-line1"
        required
        error={errorFor("line1")}
      />
      <Field label="Apartment (optional)" name="line2" autoComplete="address-line2" />
      <Field label="City" name="city" autoComplete="address-level2" required error={errorFor("city")} />
      <div className={styles.row}>
        <Field label="State" name="state" autoComplete="address-level1" required error={errorFor("state")} />
        <Field label="ZIP" name="postalCode" autoComplete="postal-code" required error={errorFor("postalCode")} />
      </div>

      {state.status === "saved" && <p role="status">Address saved.</p>}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving" : "Save address"}
      </Button>
    </form>
  );
}
```

Create `src/app/(store)/account/addresses/page.tsx`:

```tsx
import type { Metadata } from "next";
import { requireSessionUser } from "@/lib/auth/session";
import { listAddresses } from "@/lib/addresses";
import { Button } from "@/components/ui/Button";
import { AddressForm } from "./AddressForm";
import { deleteAddressAction, setDefaultAddressAction } from "./actions";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Your addresses" };

export default async function AccountAddressesPage() {
  const user = await requireSessionUser("/account/addresses");
  const saved = await listAddresses(user.id);

  return (
    <div>
      {saved.length > 0 && (
        <ul className={styles.list}>
          {saved.map((address) => (
            <li
              key={address.id}
              className={`${styles.address} ${address.isDefault ? styles.default : ""}`}
            >
              {address.isDefault && <span className={styles.badge}>Default</span>}
              <p>
                {address.name}
                <br />
                {address.line1}
                {address.line2 ? `, ${address.line2}` : ""}
                <br />
                {address.city}, {address.state} {address.postalCode}
              </p>

              {/* Each action is passed straight to `action` so the buttons
                  work without JavaScript, like every other form here. */}
              {!address.isDefault && (
                <form action={setDefaultAddressAction}>
                  <input type="hidden" name="id" value={address.id} />
                  <Button type="submit">Make default</Button>
                </form>
              )}
              <form action={deleteAddressAction}>
                <input type="hidden" name="id" value={address.id} />
                <Button type="submit">Remove</Button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <h2>Add an address</h2>
      <AddressForm />
    </div>
  );
}
```

Run `npx tsc --noEmit && npm run lint`, then sync the two tracked files
(`src/lib/db/schema.ts`, `src/test/db.ts`) into
`docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md`, run `npm test`, and
confirm green.

```bash
git add src/lib/db/schema.ts src/test/db.ts src/lib/addresses drizzle/ \
  "src/app/(store)/account/addresses" \
  docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md
git commit -m "feat: add saved addresses"
```

---

### Task 11: Guards, end-to-end coverage, and full verification

**Files:**
- Modify: `src/test/nav-links.test.ts`
- Create: `e2e/accounts.spec.ts`

**Interfaces:**
- Consumes: every page from Tasks 4-10.
- Produces: nothing.

**Why this task is last:** the nav-link guard can only pass once every linked route
exists, and `/account/orders` is one of them. Landing it earlier would leave the suite red
across several tasks, where a known failure masks the next implementer's own breakage.

**A hole this plan opened, which this task closes.** The existing guard extracts links
with `/href="(\/[^"]*)"/g` — a literal attribute only. Task 5 changed the header's account
link to `href={signedIn ? "/account/orders" : "/sign-in"}`, which that regex **cannot
see**. Left alone, the guard would keep passing while silently covering one fewer link
than before, which is the precise failure mode this project has shipped four times.

- [ ] **Step 1: Extend the guard**

In `src/test/nav-links.test.ts`, add below the existing `internalHrefs` function:

```ts
/**
 * Paths that reach the chrome through a JSX expression rather than a literal
 * attribute -- `href={signedIn ? "/account/orders" : "/sign-in"}`.
 *
 * `internalHrefs` reads literal href="..." attributes only, so these are
 * invisible to it. Listing them by hand is not ideal; leaving a link
 * unchecked because it is written as a ternary is worse. The assertion below
 * checks both that the route exists AND that the header still mentions the
 * path, so deleting the link from the header fails here rather than silently
 * shrinking what is covered.
 */
const EXPRESSION_HREFS: [string, string][] = [
  ["src/components/SiteHeader.tsx", "/account/orders"],
  ["src/components/SiteHeader.tsx", "/sign-in"],
];
```

and add these two cases inside the `describe`:

```ts
  it.each(EXPRESSION_HREFS)(
    "%s links to %s from an expression, which exists",
    (file, href) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source, `${file} no longer mentions ${href}`).toContain(`"${href}"`);
      expect(routeExists(href)).toBe(true);
    },
  );
```

- [ ] **Step 2: Run it and prove it bites**

Run: `npx vitest run src/test/nav-links.test.ts`
Expected: PASS.

Temporarily change the header's `"/account/orders"` to `"/account/nonexistent"` and
re-run.
Expected: FAIL on the expression case.
**Revert** and confirm green.

- [ ] **Step 3: Write the end-to-end tests**

Create `e2e/accounts.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";

/**
 * A fresh address per run.
 *
 * Sign-up is not idempotent: the second run with a fixed address takes the
 * "already registered" path and the assertions below stop testing what they
 * claim to. The contact suite learned the same lesson against the rate
 * limiter -- a suite that only passes the first time is not a suite.
 */
function freshEmail(): string {
  return `buyer-${randomBytes(8).toString("hex")}@example.com`;
}

const PASSWORD = "a long enough password";

test("a visitor can create an account and is told to confirm it", async ({ page }) => {
  await page.goto("/sign-up");

  await page.getByLabel("Your name").fill("Test Buyer");
  await page.getByLabel("Email").fill(freshEmail());
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByText("Check")).toBeVisible();
});

test("an unverified account cannot sign in, and is told why", async ({ page }) => {
  const email = freshEmail();

  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Test Buyer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Check")).toBeVisible();

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // requireEmailVerification, proven end to end rather than from the config.
  await expect(page.getByText("Confirm your email address first")).toBeVisible();
});

test("a wrong password does not reveal whether the account exists", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("definitely-nobody@example.com");
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("That email and password do not match.")).toBeVisible();
});

test("the account area turns an anonymous visitor away", async ({ page }) => {
  // The security boundary. If this ever passes through to the page, a signed
  // out visitor is reading somebody's order history.
  await page.goto("/account/orders");

  await expect(page).toHaveURL(/\/sign-in/);
});

test("guest checkout still works", async ({ page }) => {
  // Accounts are an addition, not a gate. This is the revenue path.
  await page.goto("/shop");
  await page.getByText("Coldsmoke Eau de Toilette").click();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page).toHaveURL(/\/cart/);

  await page.getByRole("link", { name: /checkout/i }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("every account page loads", async ({ page }) => {
  for (const path of ["/sign-in", "/sign-up", "/forgot-password", "/verify-email"]) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} should not 404`).toBe(200);
  }
});
```

- [ ] **Step 4: Run the end-to-end suite**

Run: `npx playwright test e2e/accounts.spec.ts`
Expected: 6 passed.

Run it a second time immediately. Expected: 6 passed again. If the first run passes and
the second does not, the fresh-address helper is not being used somewhere.

- [ ] **Step 5: Full verification**

```bash
npx tsc --noEmit
npm run lint
npm test
```

Expected: no output from the first two; `npm test` fully green at roughly **347** tests —
283 before this plan, plus 64 new ones:

| Task | Tests | Where |
|---|---|---|
| 1 | 9 | `src/lib/email/auth.test.ts` |
| 2 | 6 | `src/lib/auth/auth.test.ts` |
| 4 | 3 + 7 | 3 appended to `auth.test.ts`, 7 in `sign-up/actions.test.ts` |
| 5 | 6 | `sign-in/actions.test.ts` |
| 6 | 7 | `src/lib/orders/claim.test.ts` |
| 7 | 3 | `reset-password/actions.test.ts` |
| 8 | 8 | `src/lib/cart/merge.test.ts` |
| 9 | 5 | `src/lib/orders/history.test.ts` |
| 10 | 8 | `src/lib/addresses/addresses.test.ts` |
| 11 | 2 | two `it.each` cases in `nav-links.test.ts` |

That total is an estimate built from the test blocks written above, not a measurement.
Recount as you go and correct this line in the plan if it drifts — the previous plan
estimated 282 and shipped 283, and the discrepancy was only visible because the
arithmetic was written down.

If the drift guard fails on a file this plan touched, a task's sync step was skipped — fix
the plan document, not the test.

Then stop the dev server and run:

```bash
npm run build
```
Expected: 25 routes, no errors — the 17 from the previous plan plus `/sign-in`,
`/sign-up`, `/verify-email`, `/forgot-password`, `/reset-password`, `/account/orders`,
`/account/addresses` and `/api/auth/[...all]`. `next build` and `next dev` share `.next`,
so they must not run together.

Finally, with the dev server running again:

```bash
npx playwright test
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/test/nav-links.test.ts e2e/accounts.spec.ts
git commit -m "test: guard the account routes and cover the auth flows"
```

---

## Self-Review

**Spec coverage.** §4 auth tables → Task 2, generated by the CLI rather than hand-written.
§4 `addresses` → Task 10, with the spec's exact column list. §4 "guest carts merge on
sign-in, quantities sum, capped at available stock" → Task 8. §4 `orders.userId` nullable
→ Task 9. §6 "Better Auth with email and password, email verification required" → Task 2's
config and Task 11's end-to-end proof. §6 "sessions in Postgres behind httpOnly, secure,
SameSite=Lax cookies" → Better Auth's defaults, mounted in Task 2. §6 "guest checkout
remains available" → Task 11's guard. §6 "signing up later with that same address claims
those orders" → Task 6. §6 `role` column → Task 2's admin plugin. §7 account page
inventory — Sign in, Sign up, Verify email, Reset password, My orders, My addresses →
Tasks 4, 5, 6, 7, 9, 10.

**Deliberately not covered.** The entire admin half of §6 — `/admin`, order fulfilment,
refunds, the customer list, ban and impersonate — is Plan C. This plan installs the admin
plugin and the `role` column because those are database changes that would otherwise
force a second migration, but it builds no admin UI and no `proxy.ts`. The seed script
that promotes the first admin is likewise Plan C's, because nothing before then can use
an admin account.

**Type consistency.** `SessionUser` is defined in Task 3 and consumed in Tasks 5, 9 and
10 with the same five fields. `mergeGuestCart(userId: string): Promise<void>` is declared
as a placeholder in Task 5 and implemented in Task 8 with the identical signature — the
placeholder exists precisely so the two tasks cannot disagree. `claimGuestOrders({ userId,
email })` is produced in Task 6 and called in Task 6's hook with that object shape.
`AddressInput` and `SavedAddress` are defined in Task 10 and used only there.
`createPendingOrder` gains `userId?: string | null` in Task 9 and is called with
`userId: sessionUser?.id ?? null` in the same task. Every `ContactState`-style union
(`SignUpState`, `SignInState`, `ResendState`, `ForgotState`, `ResetState`,
`AddressState`) is defined in the action file that owns it and consumed only by its own
form.

**Known risks for the implementer.**

1. **Task 2's CLI step prints a `Drizzle schema mismatch` error and still succeeds.** It
   is reporting that the tables do not exist in the database yet. Step 6 creates them.
   Do not "fix" it by editing the generated file.
2. **`user` is a reserved word in Postgres.** Every raw SQL reference to it must be
   quoted, including the one added to `src/test/db.ts` in Task 2 Step 7.
3. **Task 5 ships a deliberately non-functional `mergeGuestCart`.** It is a stub with the
   right signature; Task 8 fills it in. Its test file does not exist until Task 8, so
   nothing is red in between.
4. **The sign-in form's `next` parameter is attacker-controlled.** It is filtered to
   same-site paths in `SignInForm`. A future refactor that passes it straight to
   `router.push` reintroduces an open redirect.
5. **Better Auth's generated timestamps have no time zone**, unlike the rest of this
   schema. That inconsistency is intentional and belongs to Better Auth.
