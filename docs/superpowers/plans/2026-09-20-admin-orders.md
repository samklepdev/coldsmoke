# Admin Foundation and Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/admin` boundary and the Orders section — list, detail, fulfil with carrier and tracking, and refund — so the store can actually be operated.

**Architecture:** A `(admin)` route group sibling to `(store)`, gated in its layout by `requireAdminUser()`. Order state transitions live in `src/lib/orders/` beside `markOrderPaid()`. The admin refund action moves money and writes no status; the `charge.refunded` webhook writes status and moves no money.

**Tech Stack:** Next.js 16.3.5 (App Router, Server Actions), React 19.2.8, Drizzle + Postgres, Better Auth 1.7.5 (admin plugin), Stripe via `PaymentsAdapter`, Resend + react-email, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-20-admin-orders-design.md`

## Global Constraints

- **Read the Next.js docs before writing route code.** `node_modules/next/dist/docs/01-app/`. This is not the Next.js in your training data.
- **No schema migration.** Every column used here already exists. If you think you need one, stop and re-read the spec.
- **No new `order_status` enum values.** Partial refunds leave the status unchanged.
- **`notFound()` works by throwing** and must be called in the render path — a component, or a function a component `await`s.
- **Money is never written by an admin action.** Only the webhook writes `status` and `refundedCents`.
- **`refundedCents` is set, never accumulated.** Stripe's `amount_refunded` is cumulative per charge.
- **Every transition re-reads the order inside its transaction.** Never trust what the page rendered.
- **Tests run against real Postgres** via `testDb()`. Start it with `npm run db:test:up`.
- **Comments explain why, not what.** Match the density of surrounding code.

---

## Task 1: `requireAdminUser()`

**Files:**
- Modify: `src/lib/auth/session.ts`
- Test: `src/lib/auth/session.test.ts`

**Interfaces:**
- Consumes: `getSessionUser(): Promise<SessionUser | null>`, `SessionUser` (existing).
- Produces: `requireAdminUser(next?: string): Promise<SessionUser>` — redirects to sign-in when signed out, calls `notFound()` when `role !== "admin"`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/session.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const notFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
  notFound: () => notFound(),
}));

const getSession = vi.fn();
vi.mock("./index", () => ({
  auth: { api: { getSession: () => getSession() } },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { requireAdminUser } = await import("./session");

function session(role: string | null) {
  return {
    user: {
      id: "u1",
      email: "a@example.com",
      name: "A",
      role,
      emailVerified: true,
    },
  };
}

beforeEach(() => {
  redirect.mockClear();
  notFound.mockClear();
  getSession.mockReset();
});

describe("requireAdminUser", () => {
  it("returns the user when they are an admin", async () => {
    getSession.mockResolvedValue(session("admin"));

    const user = await requireAdminUser("/admin/orders");

    expect(user.email).toBe("a@example.com");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("404s a signed-in customer rather than admitting /admin exists", async () => {
    // A redirect would confirm the route is real. The store already refuses
    // to confirm whether an address has an account; this is the same rule.
    getSession.mockResolvedValue(session("customer"));

    await expect(requireAdminUser("/admin/orders")).rejects.toThrow("NOT_FOUND");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("404s a user whose role was never set", async () => {
    getSession.mockResolvedValue(session(null));

    await expect(requireAdminUser("/admin/orders")).rejects.toThrow("NOT_FOUND");
  });

  it("sends a signed-out visitor to sign-in, carrying the destination", async () => {
    getSession.mockResolvedValue(null);

    await expect(requireAdminUser("/admin/orders")).rejects.toThrow(
      "REDIRECT:/sign-in?next=%2Fadmin%2Forders",
    );
    expect(notFound).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/auth/session.test.ts`
Expected: FAIL — `requireAdminUser is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/auth/session.ts`:

```ts
/**
 * The signed-in admin, or no return at all.
 *
 * A non-admin gets `notFound()`, not a redirect or a 403. A redirect would
 * confirm that /admin is a real route; the 404 makes it indistinguishable
 * from a path that was never registered. That matches how the sign-up and
 * resend-verification forms already refuse to confirm anything about an
 * address.
 *
 * Signed out is different from signed in without the role: the first is a
 * missing credential and is worth sending to sign-in, the second is a
 * credential that will never be enough.
 */
export async function requireAdminUser(next?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    const target = next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in";
    redirect(target);
  }
  if (user.role !== "admin") {
    notFound();
  }
  return user;
}
```

And change the `next/navigation` import at the top of the file to:

```ts
import { redirect, notFound } from "next/navigation";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/auth/session.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/session.ts src/lib/auth/session.test.ts
git commit -m "feat: add requireAdminUser, which 404s a non-admin"
```

---

## Task 2: The `db:promote-admin` script

**Files:**
- Create: `src/lib/db/promote-admin.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `db`, `user` table.
- Produces: `npm run db:promote-admin -- <email>`. No exported API.

There is no unit test here: the script's whole behaviour is process-level
(argv, exit codes, stdout). It is verified by running it in Step 3.

- [ ] **Step 1: Write the script**

Create `src/lib/db/promote-admin.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { db } from "./client";
import { user } from "./schema";

/**
 * Promotes one account to admin, by email.
 *
 * Deliberately separate from db:seed. Seeding writes product rows and is the
 * kind of script that gets run casually; granting access to every order and
 * every customer's address is not. Keeping them apart means no one can grant
 * admin by re-seeding.
 *
 * There is no bootstrap path that promotes automatically. On a public
 * storefront "the first account becomes admin" is a race a stranger can win.
 * Holding the database credentials is the authorisation.
 */
async function main(): Promise<void> {
  const email = process.argv[2]?.trim();

  if (!email) {
    console.error("Usage: npm run db:promote-admin -- <email>");
    process.exitCode = 1;
    return;
  }

  const [existing] = await db
    .select()
    .from(user)
    .where(sql`LOWER(${user.email}) = LOWER(${email})`)
    .limit(1);

  if (!existing) {
    console.error(
      `No account for ${email}. Sign up with that address first, then run this again.`,
    );
    process.exitCode = 1;
    return;
  }

  if (existing.role === "admin") {
    console.log(`${existing.email} is already an admin. Nothing to do.`);
    return;
  }

  await db.update(user).set({ role: "admin" }).where(eq(user.id, existing.id));

  console.log(
    `Promoted ${existing.email}: ${existing.role ?? "customer"} -> admin`,
  );
}

main()
  .catch((error) => {
    console.error("[promote-admin] failed", error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
```

- [ ] **Step 2: Add the script**

Append to `package.json`, in `"scripts"`, after `"db:seed"`:

```json
    "db:promote-admin": "tsx src/lib/db/promote-admin.ts",
```

- [ ] **Step 3: Verify it against the real database**

```bash
npm run db:promote-admin
```
Expected: `Usage: npm run db:promote-admin -- <email>`, exit 1.

```bash
npm run db:promote-admin -- nobody@example.com
```
Expected: `No account for nobody@example.com. Sign up with that address first, then run this again.`, exit 1.

```bash
npm run db:promote-admin -- bayou.city.labs.hou@gmail.com
```
Expected: `Promoted bayou.city.labs.hou@gmail.com: customer -> admin`

Run it a second time. Expected: `... is already an admin. Nothing to do.`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/promote-admin.ts package.json
git commit -m "feat: add db:promote-admin, the only way an admin is created"
```

---

## Task 3: The admin shell and its gate

**Files:**
- Create: `src/app/(admin)/admin/layout.tsx`
- Create: `src/app/(admin)/admin/page.tsx`
- Create: `src/app/(admin)/admin/admin.module.css`
- Test: `e2e/admin.spec.ts`

**Interfaces:**
- Consumes: `requireAdminUser()` from Task 1.
- Produces: the `/admin` route; every later task's pages render inside this layout.

Route protection is tested in Playwright, not Vitest, because the layout is
the boundary and only a real request exercises it. This mirrors
`e2e/accounts.spec.ts`.

- [ ] **Step 1: Write the failing e2e test**

Create `e2e/admin.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

/**
 * The /admin boundary.
 *
 * The 404 assertion is the security one. A redirect would confirm the route
 * exists to anyone who tried it; the point is that a customer cannot tell
 * /admin apart from a path that was never registered.
 */

test("sends a signed-out visitor to sign-in", async ({ page }) => {
  await page.goto("/admin/orders");

  await expect(page).toHaveURL(/\/sign-in\?next=/);
});

test("shows a signed-in customer a 404, not a redirect", async ({ page }) => {
  const email = `admin-guard-${Date.now()}@example.com`;

  await page.goto("/sign-up");
  await page.getByLabel("Your name").fill("Guard Test");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status").or(page.getByRole("alert"))).toBeVisible();

  const response = await page.goto("/admin/orders");

  expect(response?.status()).toBe(404);
  await expect(page).toHaveURL(/\/admin\/orders$/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/admin.spec.ts`
Expected: FAIL — `/admin/orders` does not exist, so the signed-out case does not redirect.

- [ ] **Step 3: Create the layout**

Create `src/app/(admin)/admin/layout.tsx`:

```tsx
import Link from "next/link";
import { requireAdminUser } from "@/lib/auth/session";
import styles from "./admin.module.css";

/**
 * The security boundary for every /admin route.
 *
 * The check is here, in the layout, for the same reason the account layout
 * puts it here: a layout runs on every render path for the segment, and a
 * proxy does not. Next.js 16's proxy.ts could redirect a few milliseconds
 * sooner, but an optimisation is not a boundary.
 *
 * Admin deliberately does not inherit the store layout. Storefront chrome --
 * cart link, marketing nav, footer -- is wrong here and would invite
 * navigating back into the shop mid-task.
 */
export default async function AdminLayout({
  children,
}: LayoutProps<"/admin">) {
  const user = await requireAdminUser("/admin/orders");

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <Link href="/admin/orders" className={styles.wordmark}>
          COLDSMOKE
        </Link>
        <nav className={styles.nav} aria-label="Admin">
          <Link href="/admin/orders">Orders</Link>
        </nav>
        <span className={styles.who}>{user.email}</span>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
```

- [ ] **Step 4: Create the index redirect**

Create `src/app/(admin)/admin/page.tsx`:

```tsx
import { redirect } from "next/navigation";

/** There is no admin dashboard yet. Orders is the only section. */
export default function AdminIndexPage() {
  redirect("/admin/orders");
}
```

- [ ] **Step 5: Create the stylesheet**

Create `src/app/(admin)/admin/admin.module.css`:

```css
.shell {
  min-height: 100vh;
  background: var(--ground);
}

.bar {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--line);
}

.wordmark {
  color: var(--text-bright);
  font-size: 14px;
  letter-spacing: 4px;
  font-weight: 300;
  text-decoration: none;
}

.nav {
  display: flex;
  gap: 16px;
}

.who {
  margin-left: auto;
  color: var(--text-dim);
  font-size: 13px;
}

.main {
  padding: 24px;
}
```

These four tokens are verified to exist in `src/styles/tokens.css`, which is
where this project defines them — not `globals.css`. Use them as written.

- [ ] **Step 6: Run the e2e test**

```bash
npm run dev &
npx playwright test e2e/admin.spec.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(admin)" e2e/admin.spec.ts
git commit -m "feat: add the /admin shell and its role gate"
```

---

## Task 4: The order errors

**Files:**
- Create: `src/lib/orders/errors.ts`

**Interfaces:**
- Produces: `OrderNotFoundError`, `OrderNotFulfillableError`, `OrderNotRefundableError`. Tasks 5, 8 and 9 throw these; Tasks 7 and 11 catch them.

These live in their own file rather than in `index.ts` so `fulfill.ts` and
`refund.ts` can import them without importing `index.ts`, which keeps the
dependency one-way.

- [ ] **Step 1: Create the file**

Create `src/lib/orders/errors.ts`:

```ts
/**
 * Errors for the admin-driven order transitions.
 *
 * Separate from the errors in index.ts so fulfill.ts and refund.ts can import
 * them without pulling in index.ts, which keeps the dependency one-way: the
 * new transition files may read from index.ts, and index.ts never reads back.
 */

export class OrderNotFoundError extends Error {
  constructor(public readonly orderId: string) {
    super(`No order ${orderId}`);
    this.name = "OrderNotFoundError";
  }
}

/** Only a paid order can ship. */
export class OrderNotFulfillableError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly status: string,
  ) {
    super(`Order ${orderId} is "${status}", not "paid", so it cannot be fulfilled`);
    this.name = "OrderNotFulfillableError";
  }
}

/**
 * Covers three refusals that are one thing to the admin: there is no money to
 * give back. Either the order was never paid, or it has no payment intent, or
 * it is already fully refunded.
 */
export class OrderNotRefundableError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly reason: string,
  ) {
    super(`Order ${orderId} cannot be refunded: ${reason}`);
    this.name = "OrderNotRefundableError";
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/orders/errors.ts
git commit -m "feat: add the admin order transition errors"
```

---

## Task 5: `fulfillOrder()`

**Files:**
- Create: `src/lib/orders/fulfill.ts`
- Test: `src/lib/orders/fulfill.test.ts`

**Interfaces:**
- Consumes: `db`, `orders`, `Order`; `OrderNotFoundError`, `OrderNotFulfillableError` from Task 4.
- Produces: `fulfillOrder(args: { orderId: string; carrier: string; trackingNumber: string }): Promise<Order>`.

Read `src/lib/orders/markPaid.test.ts` first for how this repo builds order
fixtures against `testDb()`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/orders/fulfill.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";
import { fulfillOrder } from "./fulfill";
import { OrderNotFoundError, OrderNotFulfillableError } from "./errors";

let ctx: Awaited<ReturnType<typeof testDb>>;

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

async function seedOrder(status: "pending" | "paid" | "fulfilled" | "refunded") {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      status,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingCents: 600,
      shippingAddress: ADDRESS,
      stripePaymentIntentId: "pi_test_1",
    })
    .returning();
  return order;
}

describe("fulfillOrder", () => {
  it("records the carrier, the tracking number and the time", async () => {
    const seeded = await seedOrder("paid");

    const order = await fulfillOrder({
      orderId: seeded.id,
      carrier: "USPS",
      trackingNumber: "9400111899223197428490",
    });

    expect(order.status).toBe("fulfilled");
    expect(order.carrier).toBe("USPS");
    expect(order.trackingNumber).toBe("9400111899223197428490");
    expect(order.fulfilledAt).toBeInstanceOf(Date);
  });

  it("refuses an order that was never paid", async () => {
    const seeded = await seedOrder("pending");

    await expect(
      fulfillOrder({ orderId: seeded.id, carrier: "USPS", trackingNumber: "X" }),
    ).rejects.toThrow(OrderNotFulfillableError);
  });

  it("refuses to fulfil the same order twice", async () => {
    // Two admins with the page open, or one double-submit. The second must
    // not overwrite the first parcel's tracking number.
    const seeded = await seedOrder("paid");
    await fulfillOrder({
      orderId: seeded.id,
      carrier: "USPS",
      trackingNumber: "FIRST",
    });

    await expect(
      fulfillOrder({ orderId: seeded.id, carrier: "UPS", trackingNumber: "SECOND" }),
    ).rejects.toThrow(OrderNotFulfillableError);

    const [row] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, seeded.id));
    expect(row.trackingNumber).toBe("FIRST");
  });

  it("refuses a refunded order", async () => {
    const seeded = await seedOrder("refunded");

    await expect(
      fulfillOrder({ orderId: seeded.id, carrier: "USPS", trackingNumber: "X" }),
    ).rejects.toThrow(OrderNotFulfillableError);
  });

  it("refuses an order that does not exist", async () => {
    await expect(
      fulfillOrder({
        orderId: "00000000-0000-0000-0000-000000000000",
        carrier: "USPS",
        trackingNumber: "X",
      }),
    ).rejects.toThrow(OrderNotFoundError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run db:test:up
npx vitest run src/lib/orders/fulfill.test.ts
```
Expected: FAIL — cannot resolve `./fulfill`.

- [ ] **Step 3: Implement**

Create `src/lib/orders/fulfill.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, type Order } from "@/lib/db/schema";
import { OrderNotFoundError, OrderNotFulfillableError } from "./errors";

/**
 * The only path that sets status 'fulfilled'.
 *
 * The order is re-read inside the transaction rather than trusted from the
 * page that submitted: an admin tab can sit open across a refund, and the
 * status it rendered may no longer be true. The same status is repeated in
 * the UPDATE's WHERE clause so two concurrent submits cannot both win --
 * the loser updates zero rows and is reported as unfulfillable rather than
 * silently overwriting the first parcel's tracking number.
 */
export async function fulfillOrder(args: {
  orderId: string;
  carrier: string;
  trackingNumber: string;
}): Promise<Order> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, args.orderId))
      .limit(1);

    if (!existing) throw new OrderNotFoundError(args.orderId);

    if (existing.status !== "paid") {
      throw new OrderNotFulfillableError(args.orderId, existing.status);
    }

    const [order] = await tx
      .update(orders)
      .set({
        status: "fulfilled",
        carrier: args.carrier,
        trackingNumber: args.trackingNumber,
        fulfilledAt: new Date(),
      })
      .where(and(eq(orders.id, args.orderId), eq(orders.status, "paid")))
      .returning();

    if (!order) {
      throw new OrderNotFulfillableError(args.orderId, "paid, then changed");
    }

    return order;
  });
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/orders/fulfill.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/orders/fulfill.ts src/lib/orders/fulfill.test.ts
git commit -m "feat: add fulfillOrder, the only path that sets fulfilled"
```

---

## Task 6: The shipping confirmation email

**Files:**
- Create: `src/lib/email/ShippingConfirmation.tsx`
- Create: `src/lib/email/shipping.ts`
- Test: `src/lib/email/shipping.test.ts`

**Interfaces:**
- Consumes: `getResend`, `EMAIL_FROM`, `OrderWithItems`, `formatOrderNumber`.
- Produces: `ShippingConfirmation({ order })`, and
  `sendShippingConfirmation(order: OrderWithItems): Promise<{ delivered: boolean }>`.

`{ delivered }` matches `src/lib/email/auth.ts`. Resend signals a rejected
message by **returning** `{ data: null, error }`, not by throwing, so the
returned error must be inspected — a bare try/catch reports success for mail
nobody received.

- [ ] **Step 1: Write the failing test**

Create `src/lib/email/shipping.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrderWithItems } from "@/lib/orders";

const sendMock = vi.fn();
vi.mock("./client", () => ({
  getResend: () => ({ emails: { send: sendMock } }),
  EMAIL_FROM: "Coldsmoke <orders@example-verified.test>",
}));

const { sendShippingConfirmation } = await import("./shipping");
const { ShippingConfirmation } = await import("./ShippingConfirmation");

beforeEach(() => {
  sendMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const ORDER = {
  id: "00000000-0000-0000-0000-000000000000",
  orderNumber: 1042,
  email: "buyer@example.com",
  status: "fulfilled",
  subtotalCents: 4500,
  discountCents: 0,
  shippingCents: 600,
  taxCents: 0,
  totalCents: 5100,
  carrier: "USPS",
  trackingNumber: "9400111899223197428490",
  shippingAddress: {
    name: "Test Buyer",
    line1: "1 Powder Lane",
    city: "Bozeman",
    state: "MT",
    postalCode: "59715",
    country: "US",
  },
  items: [],
} as unknown as OrderWithItems;

describe("ShippingConfirmation", () => {
  it("renders the carrier and the tracking number", async () => {
    const { render } = await import("@react-email/render");

    const html = await render(ShippingConfirmation({ order: ORDER }));

    expect(html).toContain("USPS");
    expect(html).toContain("9400111899223197428490");
    expect(html).toContain("CS-1042");
  });
});

describe("sendShippingConfirmation", () => {
  it("reports delivery when Resend accepts the message", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });

    expect(await sendShippingConfirmation(ORDER)).toEqual({ delivered: true });
  });

  it("reports failure when Resend returns an error instead of throwing", async () => {
    // The failure Resend actually produces for an unverified sending domain:
    // a 403 returned as a value, not raised. A bare try/catch calls this
    // success and the admin is told the customer was notified.
    sendMock.mockResolvedValue({
      data: null,
      error: { statusCode: 403, name: "validation_error", message: "not verified" },
    });

    expect(await sendShippingConfirmation(ORDER)).toEqual({ delivered: false });
  });

  it("reports failure when the call throws outright", async () => {
    sendMock.mockRejectedValue(new Error("socket hang up"));

    expect(await sendShippingConfirmation(ORDER)).toEqual({ delivered: false });
  });

  it("sends from EMAIL_FROM", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });

    await sendShippingConfirmation(ORDER);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Coldsmoke <orders@example-verified.test>",
        to: "buyer@example.com",
      }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/email/shipping.test.ts`
Expected: FAIL — cannot resolve `./shipping`.

- [ ] **Step 3: Create the template**

Create `src/lib/email/ShippingConfirmation.tsx`:

```tsx
import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Hr,
} from "@react-email/components";
import { formatOrderNumber } from "@/lib/orders/format";
import type { OrderWithItems } from "@/lib/orders";

const styles = {
  body: { background: "#0a0a0c", color: "#b7bbc1", fontFamily: "Helvetica, Arial, sans-serif", margin: 0 },
  container: { maxWidth: "540px", margin: "0 auto", padding: "40px 24px" },
  wordmark: { color: "#e4e7ec", fontSize: "20px", letterSpacing: "6px", fontWeight: 300, margin: 0 },
  label: { color: "#8d9198", fontSize: "11px", letterSpacing: "2px", textTransform: "uppercase" as const },
  text: { color: "#b7bbc1", fontSize: "14px", lineHeight: "22px" },
  bright: { color: "#d2d5da", fontSize: "14px" },
  hr: { borderColor: "#3e3f45", margin: "24px 0" },
};

export function ShippingConfirmation({ order }: { order: OrderWithItems }) {
  const address = order.shippingAddress;

  return (
    <Html>
      <Head />
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.wordmark}>COLDSMOKE</Text>
          <Hr style={styles.hr} />

          <Text style={styles.text}>
            {formatOrderNumber(order.orderNumber)} is on its way.
          </Text>

          <Hr style={styles.hr} />
          <Text style={styles.label}>Carrier</Text>
          <Text style={styles.bright}>{order.carrier}</Text>

          <Text style={styles.label}>Tracking number</Text>
          <Text style={styles.bright}>{order.trackingNumber}</Text>

          <Text style={{ ...styles.text, color: "#63666d", fontSize: "12px" }}>
            Tracking can take a day to show movement after a parcel is booked in.
          </Text>

          <Hr style={styles.hr} />
          <Text style={styles.label}>Shipping to</Text>
          <Text style={styles.text}>
            {address.name}
            <br />
            {address.line1}
            {address.line2 ? <><br />{address.line2}</> : null}
            <br />
            {address.city}, {address.state} {address.postalCode}
          </Text>

          <Hr style={styles.hr} />
          <Text style={{ ...styles.text, color: "#63666d", fontSize: "12px" }}>
            Questions or to report an adverse event: care@wearcoldsmoke.com
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
```

- [ ] **Step 4: Create the sender**

Create `src/lib/email/shipping.ts`:

```ts
import { getResend, EMAIL_FROM } from "./client";
import { ShippingConfirmation } from "./ShippingConfirmation";
import { formatOrderNumber } from "@/lib/orders/format";
import type { OrderWithItems } from "@/lib/orders";

/**
 * Never throws, and never reports a delivery that did not happen.
 *
 * Both halves matter, for different reasons than the order confirmation. A
 * throw here would surface to the admin as a failed fulfilment for a parcel
 * that really did ship. And Resend signals a rejected message by RETURNING
 * { data: null, error } rather than throwing, so the returned error has to be
 * inspected -- a try/catch alone tells the admin the customer was notified
 * when they were not.
 */
export async function sendShippingConfirmation(
  order: OrderWithItems,
): Promise<{ delivered: boolean }> {
  try {
    const { error } = await getResend().emails.send({
      from: EMAIL_FROM,
      to: order.email,
      subject: `Coldsmoke order ${formatOrderNumber(order.orderNumber)} has shipped`,
      react: ShippingConfirmation({ order }),
    });

    if (error) {
      console.error("[email] shipping confirmation rejected", {
        orderId: order.id,
        cause: error,
      });
      return { delivered: false };
    }

    return { delivered: true };
  } catch (cause) {
    console.error("[email] shipping confirmation threw", {
      orderId: order.id,
      cause,
    });
    return { delivered: false };
  }
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/lib/email/shipping.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/email/ShippingConfirmation.tsx src/lib/email/shipping.ts src/lib/email/shipping.test.ts
git commit -m "feat: add the shipping confirmation email"
```

---

## Task 7: The orders list

**Files:**
- Create: `src/lib/orders/adminList.ts`
- Create: `src/app/(admin)/admin/orders/page.tsx`
- Create: `src/app/(admin)/admin/orders/orders.module.css`
- Test: `src/lib/orders/adminList.test.ts`

**Interfaces:**
- Produces: `listOrdersForAdmin(args: { query?: string; status?: string; page?: number }): Promise<{ rows: Order[]; total: number; page: number; pageSize: number }>` and `ADMIN_PAGE_SIZE = 50`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/orders/adminList.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";
import { listOrdersForAdmin } from "./adminList";

let ctx: Awaited<ReturnType<typeof testDb>>;

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

async function seed(email: string, status: "paid" | "pending" | "fulfilled") {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email,
      status,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingAddress: ADDRESS,
    })
    .returning();
  return order;
}

describe("listOrdersForAdmin", () => {
  it("returns the newest order first", async () => {
    await seed("first@example.com", "paid");
    await seed("second@example.com", "paid");

    const { rows } = await listOrdersForAdmin({});

    expect(rows[0].email).toBe("second@example.com");
  });

  it("filters by status", async () => {
    await seed("paid@example.com", "paid");
    await seed("pending@example.com", "pending");

    const { rows } = await listOrdersForAdmin({ status: "paid" });

    expect(rows.map((r) => r.email)).toEqual(["paid@example.com"]);
  });

  it("finds an order by its number when the query is all digits", async () => {
    const seeded = await seed("buyer@example.com", "paid");
    await seed("other@example.com", "paid");

    const { rows } = await listOrdersForAdmin({
      query: String(seeded.orderNumber),
    });

    expect(rows.map((r) => r.id)).toEqual([seeded.id]);
  });

  it("finds an order by email prefix, ignoring case", async () => {
    await seed("Buyer@Example.com", "paid");
    await seed("someone@example.com", "paid");

    const { rows } = await listOrdersForAdmin({ query: "buyer" });

    expect(rows.map((r) => r.email)).toEqual(["Buyer@Example.com"]);
  });

  it("reports the unpaginated total alongside the page", async () => {
    await seed("a@example.com", "paid");
    await seed("b@example.com", "paid");

    const result = await listOrdersForAdmin({});

    expect(result.total).toBe(2);
    expect(result.pageSize).toBe(50);
    expect(result.page).toBe(1);
  });

  it("treats a page below 1 as the first page", async () => {
    await seed("a@example.com", "paid");

    const result = await listOrdersForAdmin({ page: 0 });

    expect(result.page).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it("ignores a status that is not a real order status", async () => {
    // The value arrives from a URL, so it is attacker-controlled. An
    // unrecognised one must mean "no filter", never an error page.
    await seed("a@example.com", "paid");

    const { rows } = await listOrdersForAdmin({ status: "nonsense" });

    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/orders/adminList.test.ts`
Expected: FAIL — cannot resolve `./adminList`.

- [ ] **Step 3: Implement**

Create `src/lib/orders/adminList.ts`:

```ts
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, orderStatus, type Order } from "@/lib/db/schema";

export const ADMIN_PAGE_SIZE = 50;

type OrderStatus = (typeof orderStatus.enumValues)[number];

function asStatus(value: string | undefined): OrderStatus | null {
  if (!value) return null;
  return (orderStatus.enumValues as readonly string[]).includes(value)
    ? (value as OrderStatus)
    : null;
}

/**
 * The admin orders list. Reads only -- no transition belongs in this file.
 *
 * Search matches the two things a customer quotes when they get in touch:
 * an order number, or their email address. An all-digit query is a number,
 * anything else is an email prefix. Splitting on shape rather than offering
 * two inputs keeps one box on the page and is unambiguous in practice, since
 * an email never begins with only digits.
 *
 * Both filters arrive from the URL and are therefore untrusted. An
 * unrecognised status means no filter rather than an error: a stale or
 * hand-edited link should show orders, not a crash.
 */
export async function listOrdersForAdmin(args: {
  query?: string;
  status?: string;
  page?: number;
}): Promise<{ rows: Order[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.trunc(args.page ?? 1));
  const query = args.query?.trim();
  const status = asStatus(args.status);

  const filters: SQL[] = [];

  if (status) {
    filters.push(eq(orders.status, status));
  }

  if (query) {
    if (/^\d+$/.test(query)) {
      filters.push(eq(orders.orderNumber, Number(query)));
    } else {
      filters.push(sql`${orders.email} ILIKE ${`${query}%`}`);
    }
  }

  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = await db
    .select()
    .from(orders)
    .where(where)
    .orderBy(desc(orders.createdAt))
    .limit(ADMIN_PAGE_SIZE)
    .offset((page - 1) * ADMIN_PAGE_SIZE);

  const [counted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(where);

  return {
    rows,
    total: counted?.count ?? 0,
    page,
    pageSize: ADMIN_PAGE_SIZE,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/orders/adminList.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Build the page**

Create `src/app/(admin)/admin/orders/page.tsx`:

```tsx
import Link from "next/link";
import { listOrdersForAdmin, ADMIN_PAGE_SIZE } from "@/lib/orders/adminList";
import { formatOrderNumber } from "@/lib/orders/format";
import { formatCents } from "@/lib/money";
import { orderStatus } from "@/lib/db/schema";
import styles from "./orders.module.css";

/**
 * Search and filter live in the URL rather than in client state, so a
 * filtered list survives a reload and can be sent to someone.
 */
export default async function AdminOrdersPage({
  searchParams,
}: PageProps<"/admin/orders">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const status = typeof params.status === "string" ? params.status : undefined;
  const page = typeof params.page === "string" ? Number(params.page) : 1;

  const { rows, total } = await listOrdersForAdmin({
    query,
    status,
    page: Number.isFinite(page) ? page : 1,
  });

  const pages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);

  return (
    <section>
      <h1 className={styles.heading}>Orders</h1>

      <form className={styles.filters} method="get">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Order number or email"
          aria-label="Search orders"
        />
        <select name="status" defaultValue={status ?? ""} aria-label="Status">
          <option value="">All statuses</option>
          {orderStatus.enumValues.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button type="submit">Filter</button>
      </form>

      {rows.length === 0 ? (
        <p>No orders match.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Order</th>
              <th>Placed</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((order) => (
              <tr key={order.id}>
                <td>
                  <Link href={`/admin/orders/${order.id}`}>
                    {formatOrderNumber(order.orderNumber)}
                  </Link>
                </td>
                <td>{order.createdAt.toISOString().slice(0, 10)}</td>
                <td>{order.email}</td>
                <td>{order.status}</td>
                <td>{formatCents(order.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className={styles.count}>
        {total} order{total === 1 ? "" : "s"} · page {current} of {pages}
      </p>
    </section>
  );
}
```

- [ ] **Step 6: Create the stylesheet**

Create `src/app/(admin)/admin/orders/orders.module.css`:

```css
.heading {
  font-size: 18px;
  font-weight: 400;
  letter-spacing: 1px;
  margin-bottom: 16px;
}

.filters {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.table th,
.table td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}

.count {
  margin-top: 16px;
  color: var(--text-dim);
  font-size: 13px;
}
```

- [ ] **Step 7: Verify in the browser**

```bash
npm run dev
```
Visit `/admin/orders` as the promoted admin. Confirm the list renders, the
status filter narrows it, and searching an order number finds one row.

- [ ] **Step 8: Commit**

```bash
git add src/lib/orders/adminList.ts src/lib/orders/adminList.test.ts "src/app/(admin)/admin/orders"
git commit -m "feat: add the admin orders list"
```

---

## Task 8: The order detail page

**Files:**
- Create: `src/app/(admin)/admin/orders/[id]/page.tsx`
- Create: `src/app/(admin)/admin/orders/[id]/detail.module.css`

**Interfaces:**
- Consumes: `findOrderById()` (existing, from `@/lib/orders`).
- Produces: the page that Tasks 10 and 12 add forms to.

- [ ] **Step 1: Build the page**

Create `src/app/(admin)/admin/orders/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { findOrderById } from "@/lib/orders";
import { formatOrderNumber } from "@/lib/orders/format";
import { formatCents } from "@/lib/money";
import styles from "./detail.module.css";

export default async function AdminOrderDetailPage({
  params,
}: PageProps<"/admin/orders/[id]">) {
  const { id } = await params;
  const order = await findOrderById(id);

  if (!order) notFound();

  const address = order.shippingAddress;
  const refunded = order.refundedCents > 0;

  return (
    <section>
      <h1 className={styles.heading}>
        {formatOrderNumber(order.orderNumber)}
        <span className={styles.status}>{order.status}</span>
      </h1>

      <dl className={styles.facts}>
        <dt>Customer</dt>
        <dd>{order.email}</dd>
        <dt>Placed</dt>
        <dd>{order.createdAt.toISOString()}</dd>
        {order.paidAt ? (
          <>
            <dt>Paid</dt>
            <dd>{order.paidAt.toISOString()}</dd>
          </>
        ) : null}
        {order.fulfilledAt ? (
          <>
            <dt>Shipped</dt>
            <dd>
              {order.fulfilledAt.toISOString()} · {order.carrier} ·{" "}
              {order.trackingNumber}
            </dd>
          </>
        ) : null}
        {refunded ? (
          <>
            <dt>Refunded</dt>
            <dd>{formatCents(order.refundedCents)}</dd>
          </>
        ) : null}
      </dl>

      <h2 className={styles.subheading}>Items</h2>
      <table className={styles.table}>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.id}>
              <td>
                {item.name} × {item.quantity}
              </td>
              <td className={styles.right}>{formatCents(item.totalCents)}</td>
            </tr>
          ))}
          <tr>
            <td>Subtotal</td>
            <td className={styles.right}>{formatCents(order.subtotalCents)}</td>
          </tr>
          {order.discountCents > 0 ? (
            <tr>
              <td>Discount</td>
              <td className={styles.right}>
                -{formatCents(order.discountCents)}
              </td>
            </tr>
          ) : null}
          <tr>
            <td>Shipping</td>
            <td className={styles.right}>{formatCents(order.shippingCents)}</td>
          </tr>
          <tr>
            <td>Tax</td>
            <td className={styles.right}>{formatCents(order.taxCents)}</td>
          </tr>
          <tr>
            <td>Total</td>
            <td className={styles.right}>{formatCents(order.totalCents)}</td>
          </tr>
        </tbody>
      </table>

      <h2 className={styles.subheading}>Shipping to</h2>
      <address className={styles.address}>
        {address.name}
        <br />
        {address.line1}
        {address.line2 ? (
          <>
            <br />
            {address.line2}
          </>
        ) : null}
        <br />
        {address.city}, {address.state} {address.postalCode}
      </address>
    </section>
  );
}
```

- [ ] **Step 2: Create the stylesheet**

Create `src/app/(admin)/admin/orders/[id]/detail.module.css`:

```css
.heading {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-size: 18px;
  font-weight: 400;
  letter-spacing: 1px;
  margin-bottom: 20px;
}

.status {
  color: var(--text-dim);
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
}

.subheading {
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text-dim);
  margin: 24px 0 8px;
}

.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 16px;
  font-size: 14px;
}

.facts dt {
  color: var(--text-dim);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.table td {
  padding: 6px 0;
  border-bottom: 1px solid var(--line);
}

.right {
  text-align: right;
}

.address {
  font-style: normal;
  font-size: 14px;
  line-height: 22px;
}
```

- [ ] **Step 3: Verify in the browser**

Visit an order from the list. Confirm items, totals and address render, and
that an unknown id 404s.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(admin)/admin/orders/[id]"
git commit -m "feat: add the admin order detail page"
```

---

## Task 9: Fulfilment action and form

**Files:**
- Create: `src/app/(admin)/admin/orders/[id]/actions.ts`
- Create: `src/app/(admin)/admin/orders/[id]/FulfillForm.tsx`
- Modify: `src/app/(admin)/admin/orders/[id]/page.tsx`
- Test: `src/app/(admin)/admin/orders/[id]/actions.test.ts`

**Interfaces:**
- Consumes: `fulfillOrder()` (Task 5), `sendShippingConfirmation()` (Task 6), `findOrderById()`, `requireAdminUser()`.
- Produces: `fulfillAction(prev, formData): Promise<FulfillState>` and `resendShippingAction(prev, formData): Promise<FulfillState>`, plus the `FulfillState` type.

- [ ] **Step 1: Write the failing test**

Create `src/app/(admin)/admin/orders/[id]/actions.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const sendShippingConfirmation = vi.fn(async () => ({ delivered: true }));
vi.mock("@/lib/email/shipping", () => ({
  sendShippingConfirmation: () => sendShippingConfirmation(),
}));

vi.mock("@/lib/auth/session", () => ({
  requireAdminUser: async () => ({
    id: "admin1",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    emailVerified: true,
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { fulfillAction } = await import("./actions");

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

async function seedOrder(status: "paid" | "pending") {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      status,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingAddress: ADDRESS,
      stripePaymentIntentId: "pi_test_1",
    })
    .returning();
  return order;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  sendShippingConfirmation.mockReset();
  sendShippingConfirmation.mockResolvedValue({ delivered: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("fulfillAction", () => {
  it("fulfils the order and reports success", async () => {
    const order = await seedOrder("paid");

    const state = await fulfillAction(
      { status: "idle" },
      form({ orderId: order.id, carrier: "USPS", trackingNumber: "TRACK1" }),
    );

    expect(state).toEqual({ status: "fulfilled" });
  });

  it("says so when the shipping email was rejected", async () => {
    const order = await seedOrder("paid");
    sendShippingConfirmation.mockResolvedValueOnce({ delivered: false });

    const state = await fulfillAction(
      { status: "idle" },
      form({ orderId: order.id, carrier: "USPS", trackingNumber: "TRACK1" }),
    );

    expect(state).toEqual({ status: "fulfilled-undelivered" });
  });

  it("keeps the fulfilment when the email fails", async () => {
    // The parcel shipped. Losing that because Resend was down would be far
    // worse than an unsent email, and the admin can resend.
    const order = await seedOrder("paid");
    sendShippingConfirmation.mockResolvedValueOnce({ delivered: false });

    await fulfillAction(
      { status: "idle" },
      form({ orderId: order.id, carrier: "USPS", trackingNumber: "TRACK1" }),
    );

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.status).toBe("fulfilled");
    expect(row.trackingNumber).toBe("TRACK1");
  });

  it("refuses an order that is not paid, and sends no email", async () => {
    const order = await seedOrder("pending");

    const state = await fulfillAction(
      { status: "idle" },
      form({ orderId: order.id, carrier: "USPS", trackingNumber: "TRACK1" }),
    );

    expect(state).toMatchObject({ status: "error" });
    expect(sendShippingConfirmation).not.toHaveBeenCalled();
  });

  it("requires both a carrier and a tracking number", async () => {
    const order = await seedOrder("paid");

    const state = await fulfillAction(
      { status: "idle" },
      form({ orderId: order.id, carrier: "", trackingNumber: "" }),
    );

    expect(state).toMatchObject({ status: "error" });
    expect(sendShippingConfirmation).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run "src/app/(admin)/admin/orders/[id]/actions.test.ts"`
Expected: FAIL — cannot resolve `./actions`.

- [ ] **Step 3: Implement the actions**

Create `src/app/(admin)/admin/orders/[id]/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdminUser } from "@/lib/auth/session";
import { findOrderById } from "@/lib/orders";
import { fulfillOrder } from "@/lib/orders/fulfill";
import { sendShippingConfirmation } from "@/lib/email/shipping";
import {
  OrderNotFoundError,
  OrderNotFulfillableError,
} from "@/lib/orders/errors";

const schema = z.object({
  orderId: z.uuid(),
  carrier: z.string().trim().min(1, "Name the carrier."),
  trackingNumber: z.string().trim().min(1, "Enter the tracking number."),
});

export type FulfillState =
  | { status: "idle" }
  | { status: "fulfilled" }
  /** Shipped, but the customer was not told. */
  | { status: "fulfilled-undelivered" }
  | { status: "error"; error: string };

/**
 * The layout already gates /admin, but a Server Action is its own entry
 * point: it is reachable by POST without rendering the layout at all. So the
 * check is repeated here rather than inherited.
 */
export async function fulfillAction(
  _prev: FulfillState,
  formData: FormData,
): Promise<FulfillState> {
  await requireAdminUser();

  const parsed = schema.safeParse({
    orderId: formData.get("orderId"),
    carrier: formData.get("carrier"),
    trackingNumber: formData.get("trackingNumber"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      error: parsed.error.issues[0]?.message ?? "Check the fields.",
    };
  }

  try {
    await fulfillOrder(parsed.data);
  } catch (error) {
    if (
      error instanceof OrderNotFulfillableError ||
      error instanceof OrderNotFoundError
    ) {
      return { status: "error", error: error.message };
    }
    throw error;
  }

  revalidatePath(`/admin/orders/${parsed.data.orderId}`);

  /**
   * The order is already fulfilled at this point, and nothing below may undo
   * that. The parcel shipped whether or not Resend accepted the message, so
   * a failed send is reported to the admin -- who can resend -- rather than
   * rolled back or swallowed.
   */
  const order = await findOrderById(parsed.data.orderId);
  if (!order) return { status: "fulfilled" };

  const { delivered } = await sendShippingConfirmation(order);

  return { status: delivered ? "fulfilled" : "fulfilled-undelivered" };
}

/** Sends the shipping confirmation again for an order already fulfilled. */
export async function resendShippingAction(
  _prev: FulfillState,
  formData: FormData,
): Promise<FulfillState> {
  await requireAdminUser();

  const orderId = z.uuid().safeParse(formData.get("orderId"));
  if (!orderId.success) {
    return { status: "error", error: "Unknown order." };
  }

  const order = await findOrderById(orderId.data);
  if (!order) return { status: "error", error: "Unknown order." };

  const { delivered } = await sendShippingConfirmation(order);

  return { status: delivered ? "fulfilled" : "fulfilled-undelivered" };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run "src/app/(admin)/admin/orders/[id]/actions.test.ts"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Build the form**

Create `src/app/(admin)/admin/orders/[id]/FulfillForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import {
  fulfillAction,
  resendShippingAction,
  type FulfillState,
} from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

export function FulfillForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState<FulfillState, FormData>(
    fulfillAction,
    { status: "idle" },
  );

  if (state.status === "fulfilled") {
    return <p role="status">Marked as shipped. The customer has been emailed.</p>;
  }

  if (state.status === "fulfilled-undelivered") {
    return <ResendPrompt orderId={orderId} />;
  }

  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      <Field label="Carrier" name="carrier" required />
      <Field label="Tracking number" name="trackingNumber" required />
      {state.status === "error" && <p role="alert">{state.error}</p>}
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving" : "Mark shipped"}
      </Button>
    </form>
  );
}

/**
 * Shown when the parcel shipped but the email did not. The fulfilment is not
 * in question here -- only whether the customer was told.
 */
function ResendPrompt({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState<FulfillState, FormData>(
    resendShippingAction,
    { status: "idle" },
  );

  if (state.status === "fulfilled") {
    return <p role="status">Shipping email sent.</p>;
  }

  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      <p role="alert">
        Marked as shipped, but the shipping email was rejected. The order is
        correct — only the notification failed.
      </p>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Sending" : "Resend shipping email"}
      </Button>
    </form>
  );
}
```

`Button` accepts `variant="primary" | "outline" | "quiet"` — verified. There
is no `"secondary"`. `Field` takes `label` and an optional `error`, plus the
usual input attributes.

- [ ] **Step 6: Mount it on the detail page**

Append to `src/app/(admin)/admin/orders/[id]/page.tsx`, immediately before the
closing `</section>`:

```tsx
      {order.status === "paid" ? (
        <>
          <h2 className={styles.subheading}>Fulfil</h2>
          <FulfillForm orderId={order.id} />
        </>
      ) : null}
```

And add the import at the top of that file:

```tsx
import { FulfillForm } from "./FulfillForm";
```

- [ ] **Step 7: Verify in the browser**

Mark a paid order shipped. With no verified Resend domain the send will fail,
so the expected result is the "shipping email was rejected" notice **with the
order showing as fulfilled** — which is exactly the behaviour being built.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(admin)/admin/orders/[id]"
git commit -m "feat: fulfil an order and report a failed shipping email"
```

---

## Task 10: The refund idempotency key

**Files:**
- Modify: `src/lib/payments/types.ts`
- Modify: `src/lib/payments/stripe.ts`
- Modify: `src/lib/payments/fake.ts`
- Test: `src/lib/payments/fake.test.ts`

**Interfaces:**
- Produces: `PaymentsAdapter.refund({ paymentIntentId, amountCents, idempotencyKey })`. Task 11 passes the key; `FakePayments.refunds` records it for assertions.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/payments/fake.test.ts` as a new top-level `describe`, after
the existing `describe("FakePayments", …)` block. `FakePayments` is already
imported at the top of that file, so no import change is needed.

```ts
describe("FakePayments refunds", () => {
  it("records the idempotency key it was given", async () => {
    // Two clicks on Refund are two calls. The key is what makes the second
    // one return the first refund instead of issuing another.
    const payments = new FakePayments();

    await payments.refund({
      paymentIntentId: "pi_1",
      amountCents: 5100,
      idempotencyKey: "refund:order-1:5100",
    });

    expect(payments.refunds).toEqual([
      {
        paymentIntentId: "pi_1",
        amountCents: 5100,
        idempotencyKey: "refund:order-1:5100",
      },
    ]);
  });

  it("returns the same refund for a repeated key", async () => {
    const payments = new FakePayments();
    const args = {
      paymentIntentId: "pi_1",
      amountCents: 5100,
      idempotencyKey: "refund:order-1:5100",
    };

    const first = await payments.refund(args);
    const second = await payments.refund(args);

    expect(second.refundId).toBe(first.refundId);
    expect(payments.refunds).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/payments/fake.test.ts`
Expected: FAIL — `idempotencyKey` is not accepted by `refund`.

- [ ] **Step 3: Widen the interface**

In `src/lib/payments/types.ts`, replace the `refund` member of
`PaymentsAdapter` with:

```ts
  refund(args: {
    paymentIntentId: string;
    amountCents: number;
    /**
     * Stable per logical refund. Two submits of the same refund send the same
     * key, so Stripe returns the original refund instead of issuing a second
     * one or rejecting the amount.
     */
    idempotencyKey: string;
  }): Promise<{ refundId: string }>;
```

- [ ] **Step 4: Pass it through to Stripe**

In `src/lib/payments/stripe.ts`, replace the `refund` method with:

```ts
  async refund({
    paymentIntentId,
    amountCents,
    idempotencyKey,
  }: Parameters<PaymentsAdapter["refund"]>[0]) {
    const refund = await stripe.refunds.create(
      { payment_intent: paymentIntentId, amount: amountCents },
      { idempotencyKey },
    );
    return { refundId: refund.id };
  }
```

- [ ] **Step 5: Make the fake honour it**

In `src/lib/payments/fake.ts`, replace the `refunds` field and the `refund`
method with:

```ts
  public refunds: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
  }[] = [];
```

```ts
  async refund({
    paymentIntentId,
    amountCents,
    idempotencyKey,
  }: Parameters<PaymentsAdapter["refund"]>[0]) {
    // Mirrors Stripe: a repeated key returns the original refund rather than
    // creating a second one.
    const seen = this.refunds.findIndex(
      (r) => r.idempotencyKey === idempotencyKey,
    );
    if (seen !== -1) return { refundId: `re_fake_${seen + 1}` };

    this.refunds.push({ paymentIntentId, amountCents, idempotencyKey });
    return { refundId: `re_fake_${this.refunds.length}` };
  }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/payments`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/payments
git commit -m "feat: give refunds an idempotency key"
```

---

## Task 11: `refundOrder()` and `recordRefund()`

**Files:**
- Create: `src/lib/orders/refund.ts`
- Test: `src/lib/orders/refund.test.ts`

**Interfaces:**
- Consumes: `getPayments()`, `OrderNotFoundError`, `OrderNotRefundableError`, `OrderNotFoundForPaymentError` (from `@/lib/orders`).
- Produces: `refundOrder(args: { orderId: string }): Promise<{ refundId: string; amountCents: number }>` and `recordRefund(paymentIntentId: string, eventId: string, refundedCents: number): Promise<Order | null>`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/orders/refund.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";
import { FakePayments } from "@/lib/payments/fake";
import { setPayments } from "@/lib/payments";
import { refundOrder, recordRefund } from "./refund";
import { OrderNotRefundableError } from "./errors";

let ctx: Awaited<ReturnType<typeof testDb>>;
let payments: FakePayments;

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  payments = new FakePayments();
  setPayments(payments);
});

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

async function seedOrder(
  status: "paid" | "fulfilled" | "pending",
  refundedCents = 0,
) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      status,
      subtotalCents: 4500,
      totalCents: 5100,
      refundedCents,
      shippingAddress: ADDRESS,
      stripePaymentIntentId: "pi_test_1",
    })
    .returning();
  return order;
}

describe("refundOrder", () => {
  it("refunds the whole remaining amount", async () => {
    const order = await seedOrder("paid");

    const result = await refundOrder({ orderId: order.id });

    expect(result.amountCents).toBe(5100);
    expect(payments.refunds[0]).toMatchObject({
      paymentIntentId: "pi_test_1",
      amountCents: 5100,
      idempotencyKey: `refund:${order.id}:5100`,
    });
  });

  it("refunds only what is left when part was already refunded", async () => {
    const order = await seedOrder("paid", 1000);

    const result = await refundOrder({ orderId: order.id });

    expect(result.amountCents).toBe(4100);
  });

  it("writes no status of its own", async () => {
    // The webhook is the only writer of refund state. If this action wrote
    // too, a refund issued from the Stripe dashboard would behave
    // differently from one issued here.
    const order = await seedOrder("paid");

    await refundOrder({ orderId: order.id });

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.status).toBe("paid");
    expect(row.refundedCents).toBe(0);
  });

  it("refunds a fulfilled order", async () => {
    const order = await seedOrder("fulfilled");

    await expect(refundOrder({ orderId: order.id })).resolves.toBeDefined();
  });

  it("refuses an unpaid order", async () => {
    const order = await seedOrder("pending");

    await expect(refundOrder({ orderId: order.id })).rejects.toThrow(
      OrderNotRefundableError,
    );
    expect(payments.refunds).toHaveLength(0);
  });

  it("refuses an order that is already fully refunded", async () => {
    const order = await seedOrder("paid", 5100);

    await expect(refundOrder({ orderId: order.id })).rejects.toThrow(
      OrderNotRefundableError,
    );
  });
});

describe("recordRefund", () => {
  it("sets the cumulative amount and does not accumulate it", async () => {
    // Stripe reports amount_refunded as the running total for the charge, not
    // the delta of one refund. Two partials of 1000 then 1500 arrive as 1000
    // then 2500. Adding them would give 3500 and wrongly mark the order
    // fully refunded. DO NOT "simplify" this to +=.
    const order = await seedOrder("paid");

    await recordRefund("pi_test_1", "evt_1", 1000);
    const [afterFirst] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(afterFirst.refundedCents).toBe(1000);
    expect(afterFirst.status).toBe("paid");

    await recordRefund("pi_test_1", "evt_2", 2500);
    const [afterSecond] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(afterSecond.refundedCents).toBe(2500);
    expect(afterSecond.status).toBe("paid");
  });

  it("marks the order refunded once the total is covered", async () => {
    const order = await seedOrder("paid");

    await recordRefund("pi_test_1", "evt_1", 5100);

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.refundedCents).toBe(5100);
    expect(row.status).toBe("refunded");
  });

  it("keeps the shipping record on a refunded order", async () => {
    // The parcel really did ship. Erasing that would destroy the record of it.
    const order = await seedOrder("fulfilled");
    await ctx.db
      .update(orders)
      .set({ carrier: "USPS", trackingNumber: "TRACK1" })
      .where(eq(orders.id, order.id));

    await recordRefund("pi_test_1", "evt_1", 5100);

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.status).toBe("refunded");
    expect(row.trackingNumber).toBe("TRACK1");
  });

  it("is a no-op when the event was already processed", async () => {
    await seedOrder("paid");
    await recordRefund("pi_test_1", "evt_1", 5100);

    expect(await recordRefund("pi_test_1", "evt_1", 5100)).toBeNull();
  });

  it("throws when no order matches the payment intent", async () => {
    // Money moved with no order behind it. Throwing makes the webhook return
    // non-2xx so Stripe retries and surfaces it, rather than swallowing it.
    await expect(recordRefund("pi_missing", "evt_1", 5100)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/orders/refund.test.ts`
Expected: FAIL — cannot resolve `./refund`.

- [ ] **Step 3: Implement**

Create `src/lib/orders/refund.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, stripeEvents, type Order } from "@/lib/db/schema";
import { getPayments } from "@/lib/payments";
import { OrderNotFoundForPaymentError } from "@/lib/orders";
import { OrderNotFoundError, OrderNotRefundableError } from "./errors";

/**
 * Asks Stripe for a refund. Writes nothing.
 *
 * The split is deliberate: this moves money, and recordRefund below moves
 * status. One writer means a refund issued from the Stripe dashboard lands
 * exactly like one issued from admin -- both arrive as charge.refunded and
 * take the same path.
 *
 * The idempotency key is stable for the same logical refund, so a double
 * submit returns the original refund rather than issuing a second one or
 * producing a raw Stripe rejection for an action that already worked.
 */
export async function refundOrder(args: {
  orderId: string;
}): Promise<{ refundId: string; amountCents: number }> {
  const [existing] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, args.orderId))
    .limit(1);

  if (!existing) throw new OrderNotFoundError(args.orderId);

  if (existing.status !== "paid" && existing.status !== "fulfilled") {
    throw new OrderNotRefundableError(args.orderId, `it is "${existing.status}"`);
  }

  if (!existing.stripePaymentIntentId) {
    throw new OrderNotRefundableError(args.orderId, "it has no payment intent");
  }

  const amountCents = existing.totalCents - existing.refundedCents;
  if (amountCents <= 0) {
    throw new OrderNotRefundableError(args.orderId, "it is already fully refunded");
  }

  const { refundId } = await getPayments().refund({
    paymentIntentId: existing.stripePaymentIntentId,
    amountCents,
    idempotencyKey: `refund:${existing.id}:${amountCents}`,
  });

  return { refundId, amountCents };
}

/**
 * The only path that sets status 'refunded'. Idempotent via the stripe_events
 * ledger, exactly like markOrderPaid -- a replayed webhook returns null.
 *
 * `refundedCents` is SET, never accumulated. Stripe reports amount_refunded
 * as the cumulative total for the charge, so two partial refunds of 1000 and
 * 1500 arrive as 1000 then 2500. Adding them yields 3500 and would wrongly
 * mark a half-refunded order as fully refunded.
 *
 * A partial refund leaves the status alone. There is no partially_refunded
 * state, and inventing one would mean a migration plus a new case in every
 * status filter; refundedCents already carries the fact.
 *
 * Fulfilment is not cleared. The parcel shipped, and erasing the carrier and
 * tracking number would destroy the record of it.
 */
export async function recordRefund(
  paymentIntentId: string,
  eventId: string,
  refundedCents: number,
): Promise<Order | null> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: eventId, type: "charge.refunded" })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });

    if (inserted.length === 0) return null; // Already processed.

    const [existing] = await tx
      .select()
      .from(orders)
      .where(eq(orders.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (!existing) {
      throw new OrderNotFoundForPaymentError(paymentIntentId);
    }

    const fullyRefunded = refundedCents >= existing.totalCents;

    const [order] = await tx
      .update(orders)
      .set(
        fullyRefunded
          ? { refundedCents, status: "refunded" as const }
          : { refundedCents },
      )
      .where(eq(orders.id, existing.id))
      .returning();

    return order ?? null;
  });
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/orders/refund.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/orders/refund.ts src/lib/orders/refund.test.ts
git commit -m "feat: add refundOrder and recordRefund"
```

---

## Task 12: The `charge.refunded` webhook branch

**Files:**
- Modify: `src/app/api/stripe/webhook/route.ts`
- Test: `src/app/api/stripe/webhook/route.test.ts`

**Interfaces:**
- Consumes: `recordRefund()` from Task 11.

- [ ] **Step 1: Write the failing test**

Append to `src/app/api/stripe/webhook/route.test.ts`. This uses that file's
existing helpers: `post(body)` posts a signed request, `placeOrder()` creates
a pending order, and `fake` is the `FakePayments` instance whose
`verifyWebhook` simply parses the body — so a refund event is written as
plain JSON.

```ts
describe("charge.refunded", () => {
  /** Places an order and drives it to paid, which is the only refundable state. */
  async function paidOrder() {
    const order = await placeOrder();
    await post(fake.succeededEvent(order.stripePaymentIntentId!));
    const [row] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    return row;
  }

  function refundEvent(
    paymentIntentId: string,
    amountCents: number,
    eventId: string,
  ): string {
    // amountCents is Stripe's amount_refunded: the cumulative total for the
    // charge, not the amount of this one refund.
    return JSON.stringify({
      id: eventId,
      type: "charge.refunded",
      paymentIntentId,
      amountCents,
      metadata: {},
    });
  }

  it("records a full refund and marks the order refunded", async () => {
    const order = await paidOrder();

    const response = await post(
      refundEvent(order.stripePaymentIntentId!, order.totalCents, "evt_refund_1"),
    );

    expect(response.status).toBe(200);
    const [row] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(row.status).toBe("refunded");
    expect(row.refundedCents).toBe(order.totalCents);
  });

  it("leaves a partially refunded order paid", async () => {
    const order = await paidOrder();

    await post(
      refundEvent(order.stripePaymentIntentId!, 1000, "evt_refund_2"),
    );

    const [row] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(row.status).toBe("paid");
    expect(row.refundedCents).toBe(1000);
  });

  it("returns non-2xx when no order matches, so Stripe retries", async () => {
    // Money moved with no order behind it. A 200 here loses it silently.
    const response = await post(
      refundEvent("pi_no_such_order", 5100, "evt_refund_3"),
    );

    expect(response.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/api/stripe/webhook`
Expected: FAIL — the order stays `paid`; nothing handles `charge.refunded`.

- [ ] **Step 3: Add the branch**

In `src/app/api/stripe/webhook/route.ts`, add this case to the `switch`,
after `payment_intent.payment_failed`:

```ts
      case "charge.refunded": {
        if (!event.paymentIntentId || event.amountCents === null) break;

        // amountCents is amount_refunded -- the cumulative total for the
        // charge, which is why recordRefund sets rather than accumulates.
        // A throw here is deliberate: it produces a non-2xx, rolls back the
        // ledger row, and has Stripe retry. Money that moved with no order
        // behind it must never be answered with a 200.
        await recordRefund(event.paymentIntentId, event.id, event.amountCents);
        break;
      }
```

And add to the imports at the top of the file:

```ts
import { recordRefund } from "@/lib/orders/refund";
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/app/api/stripe/webhook`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/stripe/webhook
git commit -m "feat: handle charge.refunded, the only writer of refund state"
```

---

## Task 13: The refund button

**Files:**
- Modify: `src/app/(admin)/admin/orders/[id]/actions.ts`
- Create: `src/app/(admin)/admin/orders/[id]/RefundButton.tsx`
- Modify: `src/app/(admin)/admin/orders/[id]/page.tsx`
- Test: `src/app/(admin)/admin/orders/[id]/refundAction.test.ts`

**Interfaces:**
- Produces: `refundAction(prev, formData): Promise<RefundState>`.

- [ ] **Step 1: Write the failing test**

Create `src/app/(admin)/admin/orders/[id]/refundAction.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";
import { FakePayments } from "@/lib/payments/fake";
import { setPayments } from "@/lib/payments";

let ctx: Awaited<ReturnType<typeof testDb>>;
let payments: FakePayments;

vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

vi.mock("@/lib/auth/session", () => ({
  requireAdminUser: async () => ({
    id: "admin1",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    emailVerified: true,
  }),
}));

vi.mock("@/lib/email/shipping", () => ({
  sendShippingConfirmation: async () => ({ delivered: true }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { refundAction } = await import("./actions");

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

async function seedOrder(status: "paid" | "pending" | "fulfilled") {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      status,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingAddress: ADDRESS,
      stripePaymentIntentId: "pi_test_1",
    })
    .returning();
  return order;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  payments = new FakePayments();
  setPayments(payments);
});

describe("refundAction", () => {
  it("submits the refund and says Stripe will confirm it", async () => {
    const order = await seedOrder("paid");

    const state = await refundAction({ status: "idle" }, form({ orderId: order.id }));

    expect(state).toEqual({ status: "submitted", amountCents: 5100 });
  });

  it("leaves the order untouched until the webhook lands", async () => {
    // The action moves money; the webhook moves status. Showing "refunded"
    // here would be two writers disagreeing about the same order.
    const order = await seedOrder("paid");

    await refundAction({ status: "idle" }, form({ orderId: order.id }));

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row.status).toBe("paid");
    expect(row.refundedCents).toBe(0);
  });

  it("reports a refusal rather than throwing", async () => {
    const order = await seedOrder("pending");

    const state = await refundAction({ status: "idle" }, form({ orderId: order.id }));

    expect(state).toMatchObject({ status: "error" });
    expect(payments.refunds).toHaveLength(0);
  });

  it("rejects a malformed order id", async () => {
    const state = await refundAction({ status: "idle" }, form({ orderId: "nope" }));

    expect(state).toMatchObject({ status: "error" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run "src/app/(admin)/admin/orders/[id]/refundAction.test.ts"`
Expected: FAIL — `refundAction` is not exported.

- [ ] **Step 3: Add the action**

Append to `src/app/(admin)/admin/orders/[id]/actions.ts`:

```ts
export type RefundState =
  | { status: "idle" }
  /** Sent to Stripe. The order does not change until charge.refunded lands. */
  | { status: "submitted"; amountCents: number }
  | { status: "error"; error: string };

/**
 * Sends the refund and reports only that it was sent.
 *
 * The order still reads "paid" or "fulfilled" afterwards, because the webhook
 * has not arrived yet. That is honest rather than sloppy: the refund is not
 * final until Stripe says so, and claiming otherwise here would mean two
 * different writers disagreeing about the same order.
 */
export async function refundAction(
  _prev: RefundState,
  formData: FormData,
): Promise<RefundState> {
  await requireAdminUser();

  const orderId = z.uuid().safeParse(formData.get("orderId"));
  if (!orderId.success) {
    return { status: "error", error: "Unknown order." };
  }

  try {
    const { amountCents } = await refundOrder({ orderId: orderId.data });
    revalidatePath(`/admin/orders/${orderId.data}`);
    return { status: "submitted", amountCents };
  } catch (error) {
    if (
      error instanceof OrderNotRefundableError ||
      error instanceof OrderNotFoundError
    ) {
      return { status: "error", error: error.message };
    }
    throw error;
  }
}
```

And extend that file's imports:

```ts
import { refundOrder } from "@/lib/orders/refund";
import { OrderNotRefundableError } from "@/lib/orders/errors";
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run "src/app/(admin)/admin/orders/[id]/refundAction.test.ts"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Build the button**

Create `src/app/(admin)/admin/orders/[id]/RefundButton.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { refundAction, type RefundState } from "./actions";
import { Button } from "@/components/ui/Button";
import { formatCents } from "@/lib/money";

export function RefundButton({
  orderId,
  amountCents,
}: {
  orderId: string;
  amountCents: number;
}) {
  const [state, action, pending] = useActionState<RefundState, FormData>(
    refundAction,
    { status: "idle" },
  );

  if (state.status === "submitted") {
    return (
      <p role="status">
        Refund of {formatCents(state.amountCents)} submitted. Stripe will
        confirm it shortly, and this order will then show as refunded.
      </p>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      {state.status === "error" && <p role="alert">{state.error}</p>}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Refunding" : `Refund ${formatCents(amountCents)}`}
      </Button>
    </form>
  );
}
```

- [ ] **Step 6: Mount it**

Append to `src/app/(admin)/admin/orders/[id]/page.tsx`, before the closing
`</section>`:

```tsx
      {(order.status === "paid" || order.status === "fulfilled") &&
      order.totalCents > order.refundedCents ? (
        <>
          <h2 className={styles.subheading}>Refund</h2>
          <RefundButton
            orderId={order.id}
            amountCents={order.totalCents - order.refundedCents}
          />
        </>
      ) : null}
```

And add the import:

```tsx
import { RefundButton } from "./RefundButton";
```

- [ ] **Step 7: Commit**

```bash
git add "src/app/(admin)/admin/orders/[id]"
git commit -m "feat: add the admin refund button"
```

---

## Task 14: Generalise the plan-drift guard, and verify everything

**Files:**
- Modify: `src/test/plan-drift.test.ts`

**Interfaces:** none exported.

`plan-drift.test.ts` currently pins a single plan through one `PLAN` constant.
It is widened to a list so this plan is guarded too.

- [ ] **Step 1: Make it read several plans**

In `src/test/plan-drift.test.ts`, replace the `PLAN` constant and the `plan`
binding with:

```ts
const PLANS = [
  "docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md",
  "docs/superpowers/plans/2026-09-20-admin-orders.md",
].map((p) => path.join(ROOT, p));

const plan = PLANS.map((p) => readFileSync(p, "utf8")).join("\n\n");
```

Every other line in the file continues to work unchanged: `parseBlocks()` and
the declared-count check both read the concatenated `plan` string, and joining
with blank lines cannot create a heading that spans two documents.

- [ ] **Step 2: Run the guard**

Run: `npx vitest run src/test/plan-drift.test.ts`
Expected: PASS. Any failure names a file whose shipped contents no longer
match this plan — **update the plan's code block to match the code**, never
weaken the test.

- [ ] **Step 3: Full verification**

```bash
npm run db:test:up
npx vitest run
npx tsc --noEmit
npm run lint
npx playwright test
```

Expected: all suites pass, `tsc` exit 0, `lint` exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/test/plan-drift.test.ts
git commit -m "test: guard the admin plan against drift too"
```

---

## Verification checklist

- [ ] `npm run db:promote-admin -- <email>` promotes, is idempotent, and refuses an unknown address.
- [ ] `/admin` 404s for a signed-in customer and redirects a signed-out visitor.
- [ ] The orders list filters by status and finds an order by number and by email prefix.
- [ ] Marking an order shipped stores carrier, tracking and `fulfilledAt`.
- [ ] A rejected shipping email leaves the order fulfilled and offers a resend.
- [ ] Refunding calls Stripe once per logical refund, even on a double submit.
- [ ] A partial `charge.refunded` sets `refundedCents` and leaves the status alone.
- [ ] A full `charge.refunded` marks the order refunded and keeps the tracking number.
- [ ] `charge.refunded` for an unknown intent returns non-2xx.
- [ ] `npx vitest run`, `npx tsc --noEmit`, `npm run lint` and `npx playwright test` all pass.
