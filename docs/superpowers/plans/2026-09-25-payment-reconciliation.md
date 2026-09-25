# Payment Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app a second way to learn a payment succeeded, so a webhook that never arrives stops meaning a customer is charged for nothing.

**Architecture:** A new `getIntentStatus` on the payments port lets the app ask Stripe directly. `reconcilePendingOrder` uses it when the order confirmation page renders a `pending` order, and completes the order through the *same* `markOrderPaid` + `completePaidOrder` path the webhook uses. Idempotency is entirely inherited from the existing `stripe_events` ledger — reconciliation supplies a synthetic key, `reconcile:<paymentIntentId>`.

**Tech Stack:** Next.js 16.3.5 (App Router, Server Components), React 19.2, Stripe SDK 22, Drizzle, vitest 5 (node environment), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-25-payment-reconciliation-design.md`

## Global Constraints

- **Reconciliation acts only on Stripe status `succeeded`.** Every other status — `processing`, `requires_payment_method`, `canceled` — is left alone. Failures are `handleFailure`'s job.
- **`reconcilePendingOrder` must never throw.** It runs during a page render; a Stripe outage must degrade to "still Awaiting payment", never a 500 on the page where a customer is checking whether they were charged.
- **The synthetic ledger key is exactly `` `reconcile:${paymentIntentId}` ``.** Real Stripe event ids begin `evt_`, so the key spaces must not collide.
- **No new idempotency machinery.** `markOrderPaid` already returns `null` both when the event id is already in `stripe_events` (`orders/index.ts:325`) and when the order is already `paid`/`fulfilled` (`orders/index.ts:341-343`). Do not add locks, transactions, or status pre-checks around it.
- **Exactly one confirmation email per order**, across any interleaving of webhook and reconciliation.
- **`src/lib/payments/stripe.ts` is the only file permitted to import the `stripe` package** (stated at `stripe.ts:12`). Use `getStripe()` inside it; never import Stripe elsewhere.
- **The existing webhook tests must pass untouched** after `completePaidOrder` is extracted. If a webhook test needs editing, the extraction changed behaviour and is wrong.
- **`src/test/plan-drift.test.ts` compares every `Create` block in a registered plan byte for byte against the shipped file.** Five files this plan modifies are covered by older plans — see Task 5, which is real work, not a formality.
- Verification commands: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run test:e2e`.
- DB-backed tests need Postgres: `npm run db:test:up` first.

---

### Task 1: Ask Stripe for an intent's status

**Files:**
- Modify: `src/lib/payments/types.ts` (add a method to `PaymentsAdapter`)
- Modify: `src/lib/payments/stripe.ts` (implement it)
- Modify: `src/lib/payments/fake.ts` (implement it, plus a test helper)
- Test: `src/lib/payments/fake.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `PaymentsAdapter.getIntentStatus(paymentIntentId: string): Promise<string | null>` — Stripe's status string, or `null` when no such intent exists. `FakePayments.setIntentStatus(paymentIntentId: string, status: string): void` for tests. Tasks 3 and 4 depend on both.

- [ ] **Step 1: Write the failing test**

Create `src/lib/payments/fake.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakePayments } from "./fake";

async function intent(fake: FakePayments) {
  const { paymentIntentId } = await fake.createOrUpdateIntent({
    paymentIntentId: null,
    amountCents: 5100,
    email: "buyer@example.com",
    orderId: "order_1",
    orderNumber: 1030,
  });
  return paymentIntentId;
}

describe("FakePayments.getIntentStatus", () => {
  it("reports a fresh intent as unpaid", async () => {
    const fake = new FakePayments();
    const id = await intent(fake);

    expect(await fake.getIntentStatus(id)).toBe("requires_payment_method");
  });

  it("reports succeeded once the intent has been marked so", async () => {
    const fake = new FakePayments();
    const id = await intent(fake);
    fake.markSucceeded(id);

    expect(await fake.getIntentStatus(id)).toBe("succeeded");
  });

  it("reports null for an intent it has never seen", async () => {
    const fake = new FakePayments();

    // Stripe 404s for an unknown id; the adapter turns that into null rather
    // than an exception, so a caller can tell "no such intent" from "failed".
    expect(await fake.getIntentStatus("pi_never_created")).toBeNull();
  });

  it("can be set to a status its own flow never produces", async () => {
    const fake = new FakePayments();
    const id = await intent(fake);
    fake.setIntentStatus(id, "processing");

    expect(await fake.getIntentStatus(id)).toBe("processing");
  });

  it("refuses to set a status on an intent that does not exist", async () => {
    const fake = new FakePayments();

    expect(() => fake.setIntentStatus("pi_nope", "succeeded")).toThrow(
      /No fake intent/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/payments/fake.test.ts`
Expected: FAIL — `fake.getIntentStatus is not a function`.

- [ ] **Step 3: Add the method to the port**

In `src/lib/payments/types.ts`, add this to the `PaymentsAdapter` interface, directly above `verifyWebhook`.

Append to `src/lib/payments/types.ts`:

```ts
  /**
   * The status Stripe currently reports for an intent, or null if there is no
   * such intent.
   *
   * This is how the app asks "was this actually paid?" without a webhook. The
   * webhook remains the normal path; this exists because a delivery that never
   * arrives otherwise leaves a charged customer looking at an unpaid order.
   */
  getIntentStatus(paymentIntentId: string): Promise<string | null>;
```

- [ ] **Step 4: Implement it on the Stripe adapter**

In `src/lib/payments/stripe.ts`, add this method to the `StripePayments` class, after `refund`.

Append to `src/lib/payments/stripe.ts`:

```ts
  async getIntentStatus(paymentIntentId: string): Promise<string | null> {
    try {
      const intent = await getStripe().paymentIntents.retrieve(paymentIntentId);
      return intent.status;
    } catch (error) {
      // An id Stripe does not know is an answer, not a failure: it means this
      // order never had a real intent. Anything else -- network, auth, rate
      // limit -- is a genuine failure and must propagate, so the caller can
      // tell "definitely not paid" from "could not find out".
      if (error instanceof Stripe.errors.StripeInvalidRequestError) return null;
      throw error;
    }
  }
```

- [ ] **Step 5: Implement it on the fake**

In `src/lib/payments/fake.ts`, add both methods after `markSucceeded`.

Append to `src/lib/payments/fake.ts`:

```ts
  async getIntentStatus(paymentIntentId: string): Promise<string | null> {
    return this.intents.get(paymentIntentId)?.status ?? null;
  }

  /** Test helper: sets any status, including ones this fake's own flow never
   * produces, so reconciliation's non-succeeded branches are reachable. */
  setIntentStatus(paymentIntentId: string, status: string): void {
    const existing = this.intents.get(paymentIntentId);
    if (!existing) {
      throw new Error(`No fake intent ${paymentIntentId} to set status on`);
    }
    existing.status = status;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/payments/fake.test.ts && npx tsc --noEmit`
Expected: 5 tests PASS, `tsc` clean. `tsc` matters here — it is what proves `StripePayments` also satisfies the widened interface.

- [ ] **Step 7: Commit**

```bash
git add src/lib/payments/types.ts src/lib/payments/stripe.ts src/lib/payments/fake.ts src/lib/payments/fake.test.ts
git commit -m "feat: let the app ask Stripe for a payment intent's status"
```

---

### Task 2: Extract the post-payment side effects

**Files:**
- Create: `src/lib/orders/completePaid.ts`
- Modify: `src/app/api/stripe/webhook/route.ts` (delete the private `completePaidOrder`, import the extracted one)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `completePaidOrder(orderId: string, cartId: string | null): Promise<void>`. Task 3 calls it.

This is a pure move. The function's body, comments and swallow-and-log behaviour are preserved exactly; only its location changes, so that reconciliation cannot drift into a second, subtly different implementation of "what happens after payment".

- [ ] **Step 1: Create the extracted module**

Create `src/lib/orders/completePaid.ts`:

```ts
import { findOrderById } from "./index";
import { sendOrderConfirmation } from "@/lib/email";
import { clearCart } from "@/lib/cart";

/**
 * Side effects that run after the payment has already been committed.
 *
 * These are deliberately isolated from the caller's catch. By the time we get
 * here markOrderPaid's transaction has COMMITTED: the order is paid, the stock
 * is committed, and the event id is durably in the ledger. Letting a failure
 * here escape would return 500 for a payment that actually succeeded, and the
 * retry Stripe then sends is a no-op — markOrderPaid sees the event already
 * processed and returns null — so the side effects never run anyway and the
 * only lasting result is a permanently failing event in the dashboard.
 *
 * Both effects are recoverable by other means: a missing confirmation email can
 * be resent, and a stale cart is corrected the next time the customer opens
 * their order — see `reconcilePendingOrder` in ./reconcile, which runs this
 * same function.
 *
 * Lives here rather than in the webhook route because it has two callers. A
 * second copy inside reconciliation is exactly how "what happens after
 * payment" starts meaning two different things.
 */
export async function completePaidOrder(
  orderId: string,
  cartId: string | null,
): Promise<void> {
  try {
    // Empty the cart that produced this order. The webhook is the
    // authoritative "payment succeeded" signal — clearing client-side after
    // confirmPayment would leave a full cart behind whenever the customer
    // closes the tab, letting them re-purchase by accident.
    if (cartId) await clearCart(cartId);

    const full = await findOrderById(orderId);
    if (full) await sendOrderConfirmation(full);
  } catch (error) {
    console.error("[payments] post-payment side effects failed", {
      orderId,
      error,
    });
  }
}
```

- [ ] **Step 2: Point the webhook at it**

In `src/app/api/stripe/webhook/route.ts`:

1. Delete the whole private `async function completePaidOrder(...)` declaration and its doc comment.
2. Add the import below.
3. Remove any imports left unused by the deletion — at minimum `sendOrderConfirmation` and `clearCart`. **Check whether `findOrderById` is still used elsewhere in the file before removing it**; `npm run lint` will fail on an unused import, which is the check.

Append to `src/app/api/stripe/webhook/route.ts`:

```ts
import { completePaidOrder } from "@/lib/orders/completePaid";
```

The call site at the `payment_intent.succeeded` case stays exactly as it is:

```ts
        const order = await markOrderPaid(event.paymentIntentId, event.id);
        if (order) await completePaidOrder(order.id, order.cartId);
```

- [ ] **Step 3: Verify the webhook tests pass untouched**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts && npx tsc --noEmit && npm run lint`
Expected: all PASS, `tsc` and lint clean, **with no edit to the test file**.

If a webhook test fails, the extraction changed behaviour. Do not edit the test to match — re-read the moved function against the original and find what differs.

- [ ] **Step 4: Commit**

```bash
git add src/lib/orders/completePaid.ts src/app/api/stripe/webhook/route.ts
git commit -m "refactor: extract completePaidOrder so reconciliation can share it"
```

---

### Task 3: Reconcile a pending order

**Files:**
- Create: `src/lib/orders/reconcile.ts`
- Test: `src/app/(store)/order/reconcile.test.ts`

**Interfaces:**
- Consumes: `getIntentStatus` (Task 1), `completePaidOrder` (Task 2), plus the existing `markOrderPaid(paymentIntentId, eventId)`.
- Produces: `reconcilePendingOrder(order: Order): Promise<boolean>` — `true` only when this call transitioned the order to paid, so the caller knows to re-read it. `reconcileEventId(paymentIntentId: string): string`. Task 4 calls both.

The test lives under `src/app/(store)/order/` rather than beside the source because it needs the Postgres harness and the repo keeps DB-backed action tests next to their routes. It is a unit test of the library function, not of a route.

- [ ] **Step 1: Start the test database**

Run: `npm run db:test:up`
Expected: the container reports healthy. Skip if already running.

- [ ] **Step 2: Write the failing test**

Create `src/app/(store)/order/reconcile.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { products, inventory, carts, cartItems, orders } from "@/lib/db/schema";
import { FakePayments } from "@/lib/payments/fake";

const fake = new FakePayments();
vi.mock("@/lib/payments", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments")>(
    "@/lib/payments",
  );
  return { ...actual, getPayments: () => fake };
});

const sent: string[] = [];
vi.mock("@/lib/email", () => ({
  sendOrderConfirmation: async (order: { id: string }) => {
    sent.push(order.id);
  },
}));

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { reconcilePendingOrder, reconcileEventId } = await import(
  "@/lib/orders/reconcile"
);
const { markOrderPaid } = await import("@/lib/orders");

let cartId: string;
let productId: string;

/** A pending order with a cart that still holds two items — order 1030's shape. */
async function pendingOrder(paymentIntentId: string | null) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      orderNumber: 1030,
      email: "buyer@example.com",
      status: "pending",
      cartId,
      stripePaymentIntentId: paymentIntentId,
      subtotalCents: 4500,
      shippingCents: 600,
      taxCents: 0,
      discountCents: 0,
      totalCents: 5100,
      // `line2` is omitted, not null: Address types it `line2?: string`, so
      // null does not type-check.
      shippingAddress: {
        name: "Test Buyer",
        line1: "1 Powder Lane",
        city: "Bozeman",
        state: "MT",
        postalCode: "59715",
        country: "US",
      },
    })
    .returning();
  return order;
}

async function intentFor(orderId: string) {
  const { paymentIntentId } = await fake.createOrUpdateIntent({
    paymentIntentId: null,
    amountCents: 5100,
    email: "buyer@example.com",
    orderId,
    orderNumber: 1030,
  });
  return paymentIntentId;
}

const itemsLeft = async () =>
  (await ctx.db.select().from(cartItems).where(eq(cartItems.cartId, cartId)))
    .length;

const statusOf = async (id: string) =>
  (await ctx.db.select().from(orders).where(eq(orders.id, id)))[0].status;

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  fake.intents.clear();
  sent.length = 0;

  const [bottle] = await ctx.db
    .insert(products)
    .values({
      slug: "coldsmoke-edt-50ml",
      name: "Coldsmoke Eau de Toilette",
      description: "d",
      priceCents: 4500,
      sku: "CS-1",
    })
    .returning();
  productId = bottle.id;
  await ctx.db.insert(inventory).values({ productId, onHand: 5 });

  const [cart] = await ctx.db.insert(carts).values({}).returning();
  cartId = cart.id;
  await ctx.db.insert(cartItems).values({ cartId, productId, quantity: 2 });
});

describe("reconcilePendingOrder", () => {
  it("marks a pending order paid when Stripe says the intent succeeded", async () => {
    // Order 1030's exact situation: Stripe captured the money, the webhook
    // never arrived, and the cart still holds what was bought.
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));
    fake.markSucceeded(pi);

    const changed = await reconcilePendingOrder({
      ...order,
      stripePaymentIntentId: pi,
    });

    expect(changed).toBe(true);
    expect(await statusOf(order.id)).toBe("paid");
    expect(await itemsLeft()).toBe(0);
    expect(sent).toEqual([order.id]);
  });

  it("leaves a still-processing payment alone", async () => {
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));
    fake.setIntentStatus(pi, "processing");

    const changed = await reconcilePendingOrder({
      ...order,
      stripePaymentIntentId: pi,
    });

    expect(changed).toBe(false);
    expect(await statusOf(order.id)).toBe("pending");
    expect(await itemsLeft()).toBe(2);
    expect(sent).toEqual([]);
  });

  it("leaves an unpaid intent alone", async () => {
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));

    const changed = await reconcilePendingOrder({
      ...order,
      stripePaymentIntentId: pi,
    });

    expect(changed).toBe(false);
    expect(await statusOf(order.id)).toBe("pending");
  });

  it("does nothing for an order with no payment intent", async () => {
    const order = await pendingOrder(null);

    const changed = await reconcilePendingOrder(order);

    expect(changed).toBe(false);
    expect(await statusOf(order.id)).toBe("pending");
  });

  it("sends no second email when the webhook already completed the order", async () => {
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));
    fake.markSucceeded(pi);

    // The webhook wins the race.
    const paid = await markOrderPaid(pi, "evt_real_1");
    expect(paid).not.toBeNull();
    sent.length = 0;

    const changed = await reconcilePendingOrder({
      ...order,
      stripePaymentIntentId: pi,
    });

    expect(changed).toBe(false);
    expect(sent).toEqual([]);
  });

  it("is safe to run twice — the ledger key stops the second", async () => {
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));
    fake.markSucceeded(pi);
    const withPi = { ...order, stripePaymentIntentId: pi };

    expect(await reconcilePendingOrder(withPi)).toBe(true);
    expect(await reconcilePendingOrder(withPi)).toBe(false);
    expect(sent).toEqual([order.id]);
  });

  it("swallows a payments failure rather than breaking the page", async () => {
    const order = await pendingOrder(null);
    const pi = await intentFor(order.id);
    await ctx.db
      .update(orders)
      .set({ stripePaymentIntentId: pi })
      .where(eq(orders.id, order.id));

    const boom = vi
      .spyOn(fake, "getIntentStatus")
      .mockRejectedValue(new Error("stripe is down"));

    // Must resolve, not reject: this runs inside a page render.
    const changed = await reconcilePendingOrder({
      ...order,
      stripePaymentIntentId: pi,
    });

    expect(changed).toBe(false);
    expect(await statusOf(order.id)).toBe("pending");
    boom.mockRestore();
  });

  it("namespaces its ledger key away from real Stripe event ids", () => {
    // Real ids begin "evt_". A collision would make one path silently skip.
    expect(reconcileEventId("pi_123")).toBe("reconcile:pi_123");
    expect(reconcileEventId("pi_123").startsWith("evt_")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run "src/app/(store)/order/reconcile.test.ts"`
Expected: FAIL — cannot resolve `@/lib/orders/reconcile`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/orders/reconcile.ts`:

```ts
import type { Order } from "@/lib/db/schema";
import { getPayments } from "@/lib/payments";
import { markOrderPaid } from "./index";
import { completePaidOrder } from "./completePaid";

/**
 * The ledger key reconciliation writes to `stripe_events`.
 *
 * Namespaced away from real Stripe event ids, which begin "evt_", so the two
 * paths cannot collide in the ledger and each still blocks the other from
 * doing the work twice. It doubles as a metric: `reconcile:` rows are orders
 * whose webhook never landed, and a growing count means webhook delivery
 * itself needs fixing rather than compensating for.
 */
export function reconcileEventId(paymentIntentId: string): string {
  return `reconcile:${paymentIntentId}`;
}

/**
 * Asks Stripe whether a pending order was in fact paid, and completes it if so.
 *
 * The webhook is the normal path and this changes nothing about it. This exists
 * because the webhook is the ONLY path: a delivery that never arrives leaves a
 * charged customer looking at an unpaid order, with no confirmation email, no
 * committed stock, and a cart still holding what they just bought. That
 * happened -- order 1030, $51.00 captured, status pending.
 *
 * Returns true only when THIS call transitioned the order, so the caller knows
 * to re-read it.
 *
 * Never throws. It runs during a page render, and a Stripe outage must degrade
 * to "still Awaiting payment" rather than a 500 on the page where a customer is
 * trying to find out whether they were charged.
 */
export async function reconcilePendingOrder(order: Order): Promise<boolean> {
  if (order.status !== "pending") return false;
  if (!order.stripePaymentIntentId) return false;

  const paymentIntentId = order.stripePaymentIntentId;

  try {
    const status = await getPayments().getIntentStatus(paymentIntentId);
    // Only "succeeded" is acted on. A failed or cancelled payment is
    // handleFailure's job, and "processing" has not resolved yet.
    if (status !== "succeeded") return false;

    // No pre-check on the order's status and no lock: markOrderPaid inserts
    // the key and re-reads the order inside one transaction, returning null if
    // either the key or a paid status is already there. Whichever of webhook
    // and reconciliation arrives second gets null and skips the side effects,
    // so the confirmation email cannot go twice.
    const paid = await markOrderPaid(
      paymentIntentId,
      reconcileEventId(paymentIntentId),
    );
    if (!paid) return false;

    await completePaidOrder(paid.id, paid.cartId);
    return true;
  } catch (error) {
    console.error("[reconcile] could not reconcile order", {
      orderId: order.id,
      paymentIntentId,
      error,
    });
    return false;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run "src/app/(store)/order/reconcile.test.ts"`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/orders/reconcile.ts "src/app/(store)/order/reconcile.test.ts"
git commit -m "feat: reconcile a pending order against Stripe

A webhook that never arrives left order 1030 pending with \$51.00
captured. Reconciliation asks Stripe directly and completes the order
through the same path the webhook uses."
```

---

### Task 4: Run reconciliation when the order page renders

**Files:**
- Modify: `src/app/(store)/order/[number]/page.tsx`
- Modify: `e2e/checkout.spec.ts` (add the missing cart assertion)

**Interfaces:**
- Consumes: `reconcilePendingOrder(order)` from Task 3.
- Produces: nothing.

- [ ] **Step 1: Wire reconciliation into the page**

In `src/app/(store)/order/[number]/page.tsx`, add the import, change `const order` to `let order`, and insert the reconciliation block immediately after the `if (!order) notFound();` guard and before `const address = order.shippingAddress;`.

Append to `src/app/(store)/order/[number]/page.tsx`:

```tsx
import { reconcilePendingOrder } from "@/lib/orders/reconcile";
  // A webhook that never arrived leaves a paid order reading "pending"
  // forever, with the customer's cart still holding what they bought. Ask
  // Stripe directly before rendering.
  //
  // During render rather than in a Server Action, so it works with JavaScript
  // disabled like the rest of this store. Safe to run on every render because
  // markOrderPaid's ledger makes it idempotent, and cheap because it only
  // calls Stripe for orders that are still pending.
  if (order.status === "pending") {
    const reconciled = await reconcilePendingOrder(order);
    if (reconciled) {
      const fresh = await findOrderByNumberForIds(orderNumber, granted);
      if (fresh) order = fresh;
    }
  }
```

The declaration a few lines above changes from `const order = await findOrderByNumberForIds(...)` to `let order = await findOrderByNumberForIds(...)`.

- [ ] **Step 2: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean. `tsc` is the check that `let` reassignment still satisfies the `OrderWithItems` type the rest of the page reads.

- [ ] **Step 3: Add the e2e assertion that would have caught this**

In `e2e/checkout.spec.ts`, in the test `a guest can buy a bottle`, add this immediately after the existing `await expect(page.getByText("Confirmed")).toBeVisible({ timeout: 30_000 });`.

Append to `e2e/checkout.spec.ts`:

```ts
  // Paying empties the cart. Asserting only "Confirmed" is why a paid order
  // leaving a full cart behind reached a human instead of this suite: the
  // status flipped correctly while the header still read "Cart (2)".
  await expect(page.getByRole("link", { name: /^Cart/ })).toHaveText("Cart", {
    timeout: 15_000,
  });
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run test:e2e`
Expected: all green.

Note on the e2e: `a guest can buy a bottle` self-skips unless a `stripe listen` is forwarding webhooks. **A skip means the new assertion did not run.** To exercise it, start `stripe listen --forward-to localhost:3000/api/stripe/webhook` in another terminal and re-run. Report which of the two happened — a skipped test is not evidence.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(store)/order/[number]/page.tsx" e2e/checkout.spec.ts
git commit -m "feat: reconcile pending orders when the confirmation page loads

Also asserts the cart empties after payment, which the payment e2e
never checked."
```

---

### Task 5: Reconcile plan drift and verify the whole change

**Files:**
- Modify: `docs/superpowers/plans/2026-09-19-coldsmoke-storefront-checkout.md`
- Modify: `docs/superpowers/plans/2026-09-20-cart-quantity-stepper.md`
- Modify: `src/test/plan-drift.test.ts:23-31` (the `PLANS` array)

**Interfaces:**
- Consumes: every file changed in Tasks 1-4.
- Produces: nothing.

**This is real work, not bookkeeping.** Five files this plan modifies are described by older plans with full `Create` blocks, compared **byte for byte**:

| Drifted file | Plan holding its `Create` block |
|---|---|
| `src/lib/payments/types.ts` | `2026-09-19-coldsmoke-storefront-checkout.md` |
| `src/lib/payments/stripe.ts` | `2026-09-19-coldsmoke-storefront-checkout.md` |
| `src/lib/payments/fake.ts` | `2026-09-19-coldsmoke-storefront-checkout.md` |
| `src/app/api/stripe/webhook/route.ts` | `2026-09-19-coldsmoke-storefront-checkout.md` |
| `e2e/checkout.spec.ts` | declared in both `2026-09-19-coldsmoke-storefront-checkout.md` and `2026-09-20-cart-quantity-stepper.md` — fix whichever block the guard compares; if both are full `Create` blocks, fix both |

`src/app/(store)/order/[number]/page.tsx` is not in any plan, so it needs nothing.

- [ ] **Step 1: See the current damage**

Run: `npx vitest run src/test/plan-drift.test.ts`
Expected: FAIL, roughly five `matches the plan byte for byte` cases naming the files above.

Record the exact list. It is the checklist for the next step.

- [ ] **Step 2: Update each stale plan document**

For every failing file, copy the **shipped file's current contents** into the corresponding `Create` block in the plan named above.

The shipped source is correct; the older plan documents are the stale side. Do not edit source, do not weaken or skip any assertion in `src/test/plan-drift.test.ts`, and do not add `plan-drift: partial` markers to dodge a comparison.

- [ ] **Step 3: Register this plan with the guard**

Add one entry to the `PLANS` array in `src/test/plan-drift.test.ts`, after the existing entries.

Append to `src/test/plan-drift.test.ts`:

```ts
  "docs/superpowers/plans/2026-09-25-payment-reconciliation.md",
```

This brings this plan's own `Create` blocks under the guard — `completePaid.ts`, `reconcile.ts`, `fake.test.ts`, `reconcile.test.ts`. They should already match. If one does not, report which and why before changing anything.

- [ ] **Step 4: Run the guard**

Run: `npx vitest run src/test/plan-drift.test.ts`
Expected: PASS, zero failures.

- [ ] **Step 5: Full verification**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run test:e2e`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans src/test/plan-drift.test.ts
git commit -m "docs: sync older plans with payment reconciliation"
```

---

### Task 6: Recover order 1030

**Files:** none. This is an operational step against the running system.

**Interfaces:**
- Consumes: the whole feature.
- Produces: nothing.

Order 1030 is genuinely paid — `pi_3UJe42C4O5W0d4Lo3Vq1CSNv` reports `status: succeeded`, `amount_received: 5100` — and has been sitting `pending` since 2026-09-25 18:41.

**Do not run this task without the user's explicit go-ahead in the current conversation.** It sends a real confirmation email to the address on that order. Ask, then act.

- [ ] **Step 1: Confirm the before state**

```bash
docker exec -i coldsmoke-dev-db psql -U coldsmoke -d coldsmoke -c \
  "SELECT order_number, status, paid_at FROM orders WHERE order_number = 1030;"
```
Expected: `pending`, `paid_at` null.

- [ ] **Step 2: Load the order page and let reconciliation do it**

With the dev server running, open `http://localhost:3000/order/1030` in the browser that holds the order's access cookie.

This is the whole point of the feature: the fix and the recovery are the same code path. If it needs a manual database edit instead, the feature does not work.

- [ ] **Step 3: Confirm the after state**

```bash
docker exec -i coldsmoke-dev-db psql -U coldsmoke -d coldsmoke -c \
  "SELECT order_number, status, paid_at FROM orders WHERE order_number = 1030;" -c \
  "SELECT id FROM stripe_events WHERE id LIKE 'reconcile:%';" -c \
  "SELECT COALESCE(SUM(ci.quantity),0) AS items_left FROM orders o LEFT JOIN cart_items ci ON ci.cart_id = o.cart_id WHERE o.order_number = 1030;"
```
Expected: status `paid` with a `paid_at`; one `reconcile:pi_3UJe42C4O5W0d4Lo3Vq1CSNv` row; `items_left` 0.

If the cookie for order 1030 is gone, re-establish access through `/order-lookup` with that order's email rather than editing the database.

---

## Success criteria

- A pending order whose payment succeeded becomes `paid` on the next view of its confirmation page, with its cart emptied and one confirmation email sent.
- No interleaving of webhook and reconciliation sends two confirmation emails.
- A Stripe outage cannot break the order confirmation page.
- Order 1030 reads `paid`, its cart is empty, and a `reconcile:` row records why.
- `npm test`, `npx tsc --noEmit`, `npm run lint` and `npm run test:e2e` are green, with the plans in sync.
