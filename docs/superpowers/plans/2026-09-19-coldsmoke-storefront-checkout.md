# Coldsmoke Storefront & Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Coldsmoke storefront through a working guest checkout — browse two products, add to cart, pay with Stripe Elements, receive a confirmation email — on a correct, concurrency-safe inventory and pricing foundation.

**Architecture:** A single Next.js App Router application structured as a modular monolith. All store logic lives in `src/lib/` modules with explicit interfaces; Server Components read and Server Actions write, calling those modules as thin wrappers. All money is computed in exactly one pure function, `pricing.quote()`, so the cart page, the PaymentIntent, and the Stripe webhook cannot disagree about what a customer is charged. Only `lib/payments` imports the Stripe SDK, so everything else tests against a fake adapter.

**Tech Stack:** Next.js 16.3.5, React 19.2.8, TypeScript 5, Postgres (Neon) + Drizzle ORM via postgres.js, Stripe Elements (`@stripe/react-stripe-js`), Resend + React Email, Vitest, Playwright, CSS Modules.

**Source spec:** `docs/superpowers/specs/2026-09-19-coldsmoke-store-design.md`

**This is Plan 1 of 4.** Plan 2 adds customer accounts (Better Auth), Plan 3 adds the admin panel, Plan 4 adds marketing pages and brand polish. This plan delivers a site that can sell to guests.

---

## Global Constraints

These apply to every task. Each task's requirements implicitly include this section.

- **All money is integer cents.** No floats, no decimals, no `Number.prototype.toFixed` arithmetic. Format for display only at the render boundary.
- **Never trust client-supplied amounts.** The server recomputes every total from the database immediately before creating or updating a PaymentIntent.
- **The Stripe webhook is the only writer of order status `paid`.** A client-side success callback is a hint, not proof.
- **Webhook handling must be idempotent.** Every handler checks the `stripe_events` ledger first and returns 200 for an already-processed event id.
- **`src/lib/` modules never import from `src/app/`.** Dependencies point inward.
- **Only `src/lib/payments/` imports the `stripe` package.** All other code depends on the `PaymentsAdapter` interface.
- **Shipping:** flat `600` cents; free when post-discount subtotal is `>= 5000` cents. US addresses only.
- **Prices are seed data, not constants.** `4500` (50 mL) and `600` (2 mL sample) live in the database, never hardcoded in application logic.
- **Brand voice in all user-facing copy:** spare and dry, short sentences, no exclamation points.
- **Dark-first styling.** Design tokens from the spec's Section 7 table; the silver gradient is reserved for the wordmark alone.
- **Accessibility is a requirement:** WCAG AA contrast, visible focus states, labeled inputs, errors announced to screen readers.
- **Node 20+.** Package manager is npm (the repo has `package-lock.json`).
- **Commit after every task.** Conventional commit prefixes (`feat:`, `test:`, `chore:`, `fix:`).

### Deviations from the spec (deliberate, noted for the reviewer)

1. **`orders.userId` has no foreign key in this plan.** The Better Auth `user` table does not exist until Plan 2. The column is created as nullable `text`; Plan 2 adds the FK constraint.
2. **Two columns added to `orders` beyond the spec:** `reservationExpiresAt` (timestamp) and `inventoryState` (`none` | `reserved` | `committed` | `released`). The spec describes 15-minute reservation expiry but not how release is tracked. These make release idempotent without a separate reservations table.
3. **`pricing.quote()` takes `taxCents` as an input** rather than calling Stripe Tax itself. This keeps the function pure and fully unit-testable; `lib/payments` fetches the tax figure and passes it in.
4. **Database driver is postgres.js, not `@neondatabase/serverless` HTTP.** The Neon HTTP driver does not support multi-statement transactions, and inventory reservation requires them.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/db/client.ts` | Drizzle client singleton over postgres.js |
| `src/lib/db/schema.ts` | All table definitions and enums |
| `src/lib/db/seed.ts` | Seed the two products and their inventory |
| `src/lib/money.ts` | Cents formatting helper (display boundary only) |
| `src/lib/catalog/index.ts` | `getActiveProducts`, `getProductBySlug` |
| `src/lib/pricing/quote.ts` | The single money calculation (pure) |
| `src/lib/discounts/index.ts` | `validate`, `redeem` |
| `src/lib/cart/index.ts` | Cart cookie identity, line mutations |
| `src/lib/inventory/index.ts` | `reserve`, `commit`, `release`, `releaseExpired` |
| `src/lib/orders/index.ts` | `createPending`, `markPaid`, `findByNumber` |
| `src/lib/payments/types.ts` | `PaymentsAdapter` interface |
| `src/lib/payments/stripe.ts` | Stripe implementation (only file importing `stripe`) |
| `src/lib/payments/fake.ts` | In-memory adapter for tests |
| `src/lib/email/` | Resend client and React Email templates |
| `src/app/(store)/` | Home, shop, product, cart, checkout, confirmation, lookup |
| `src/app/api/stripe/webhook/route.ts` | Webhook handler |
| `src/app/api/cron/release-reservations/route.ts` | Reservation sweep |
| `src/components/ui/` | Design primitives (Button, Field, Price, Wordmark) |
| `src/styles/tokens.css` | Brand design tokens |

---

## Task 1: Project foundation — tooling, tokens, and test harness

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`, `docker-compose.test.yml`, `.env.example`, `src/styles/tokens.css`, `src/lib/money.ts`, `src/lib/money.test.ts`
- Modify: `src/app/globals.css`, `src/app/layout.tsx`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `formatCents(cents: number): string` from `@/lib/money`; CSS custom properties `--ground`, `--panel`, `--line`, `--text`, `--text-dim`, `--text-bright`; npm scripts `test`, `test:watch`, `db:test:up`, `db:test:down`

- [ ] **Step 1: Install dependencies**

```bash
npm install drizzle-orm postgres stripe @stripe/stripe-js @stripe/react-stripe-js resend @react-email/components zod
npm install -D drizzle-kit vitest @vitejs/plugin-react dotenv tsx
```

- [ ] **Step 2: Add npm scripts**

Edit `package.json`, replacing the `"scripts"` block:

```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/lib/db/migrate.ts",
    "db:seed": "tsx src/lib/db/seed.ts",
    "db:test:up": "docker compose -f docker-compose.test.yml up -d --wait",
    "db:test:down": "docker compose -f docker-compose.test.yml down -v"
  },
```

- [ ] **Step 3: Create the Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["dotenv/config"],
    // Integration test files share one Postgres database and each TRUNCATEs
    // it in beforeEach. Run files one at a time so those truncations cannot
    // race and tear out another file's fixtures mid-test. The suite is small
    // and runs in under a second, so the lost parallelism costs nothing.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
```

- [ ] **Step 4: Create the test database compose file**

Create `docker-compose.test.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: coldsmoke
      POSTGRES_PASSWORD: coldsmoke
      POSTGRES_DB: coldsmoke_test
    ports:
      - "54329:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U coldsmoke -d coldsmoke_test"]
      interval: 2s
      timeout: 3s
      retries: 20
```

- [ ] **Step 5: Create the env template**

Create `.env.example`:

```bash
DATABASE_URL=postgres://user:password@host/coldsmoke
TEST_DATABASE_URL=postgres://coldsmoke:coldsmoke@localhost:54329/coldsmoke_test
STRIPE_SECRET_KEY=sk_test_xxx
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
RESEND_API_KEY=re_xxx
EMAIL_FROM="Coldsmoke <orders@wearcoldsmoke.com>"
CRON_SECRET=generate_a_random_string
NEXT_PUBLIC_SITE_URL=http://localhost:3000
BETTER_AUTH_SECRET=generate_with_openssl_rand_base64_32
BETTER_AUTH_URL=http://localhost:3000
```

- [ ] **Step 6: Write the failing test for the money helper**

Create `src/lib/money.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatCents } from "./money";

describe("formatCents", () => {
  it("formats whole dollars", () => {
    expect(formatCents(4500)).toBe("$45.00");
  });

  it("formats cents", () => {
    expect(formatCents(605)).toBe("$6.05");
  });

  it("formats zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("formats large amounts with a thousands separator", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
  });

  it("formats negative amounts, used for discount lines", () => {
    expect(formatCents(-500)).toBe("-$5.00");
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -- src/lib/money.test.ts`
Expected: FAIL — `Failed to resolve import "./money"`

- [ ] **Step 8: Implement the money helper**

Create `src/lib/money.ts`:

```ts
const formatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

/**
 * Formats integer cents for display. This is the only place cents become a
 * decimal string — never do money arithmetic on the result.
 */
export function formatCents(cents: number): string {
  return formatter.format(cents / 100);
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- src/lib/money.test.ts`
Expected: PASS — 5 tests passing

- [ ] **Step 10: Create the brand design tokens**

Create `src/styles/tokens.css`:

```css
:root {
  --ground: #0a0a0c;
  --panel: #17171b;
  --panel-raised: #1f1f24;
  --line: #3e3f45;
  --line-bright: #65666e; /* AA 3:1 non-text for control borders; #4a4b51 was 2.28:1 */

  --text: #b7bbc1;
  --text-dim: #8d9198;
  --text-bright: #d2d5da;
  --text-faint: #82858d; /* AA 4.5:1 on ground and panel; #63666d was 3.44:1 */

  --silver-start: #9aa0a8;
  --silver-mid: #e4e7ec;
  --silver-end: #9aa0a8;

  --danger: #e0645c;
  --success: #7fb08a;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 1rem;
  --space-4: 1.5rem;
  --space-5: 2.5rem;
  --space-6: 4rem;
  --space-7: 6rem;

  --measure: 62ch;
  --page-max: 1160px;

  --track-wide: 0.42em;
  --track-mid: 0.18em;
  --track-tight: 0.04em;
}
```

- [ ] **Step 11: Replace the scaffold's global styles**

Replace the entire contents of `src/app/globals.css`:

```css
@import "../styles/tokens.css";

*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  height: 100%;
  color-scheme: dark;
}

body {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ground);
  color: var(--text);
  font-family: var(--font-sans), system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

a {
  color: inherit;
  text-decoration: none;
}

img,
svg {
  display: block;
  max-width: 100%;
}

button,
input,
select,
textarea {
  font: inherit;
  color: inherit;
}

:focus-visible {
  outline: 2px solid var(--silver-mid);
  outline-offset: 3px;
}

::selection {
  background: var(--silver-start);
  color: var(--ground);
}
```

- [ ] **Step 12: Update the root layout with brand metadata**

Replace the contents of `src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const sans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  ),
  title: {
    default: "Coldsmoke — Cold air. Dark spice.",
    template: "%s · Coldsmoke",
  },
  description:
    "A cologne that opens cold and dries down dark. Bergamot and iced spearmint over cardamom, dark musk, and smoky vetiver.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={sans.variable}>
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 13: Verify the app still builds**

Run: `npm run build`
Expected: Build completes with no type errors.

- [ ] **Step 14: Commit**

```bash
git add package.json package-lock.json vitest.config.ts docker-compose.test.yml .env.example src/styles/tokens.css src/lib/money.ts src/lib/money.test.ts src/app/globals.css src/app/layout.tsx
git commit -m "chore: project foundation, brand tokens, and test harness"
```

---

## Task 2: Database schema and seed data

**Files:**
- Create: `drizzle.config.ts`, `src/lib/db/client.ts`, `src/lib/db/schema.ts`, `src/lib/db/migrate.ts`, `src/lib/db/seed.ts`

**Interfaces:**
- Consumes: `.env` from Task 1
- Produces: `db` client from `@/lib/db/client`; tables `products`, `productImages`, `inventory`, `carts`, `cartItems`, `discountCodes`, `orders`, `orderItems`, `stripeEvents`, `inventoryAdjustments`; types `Product`, `Order`, `OrderStatus`, `InventoryState`

- [ ] **Step 1: Create the Drizzle config**

Create `drizzle.config.ts`:

```ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/lib/db/schema.ts", "./src/lib/db/auth-schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 2: Define the schema**

Create `src/lib/db/schema.ts`:

```ts
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uuid,
  pgEnum,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";

/**
 * Better Auth's tables live in a generated file so regenerating them cannot
 * clobber hand-written tables. Re-exported here so `@/lib/db/schema` stays the
 * single import for every table in the application.
 */
import { user, session, account, verification } from "./auth-schema";

export { user, session, account, verification };

export const orderStatus = pgEnum("order_status", [
  "pending",
  "paid",
  "fulfilled",
  "payment_failed",
  "cancelled",
  "refunded",
]);

export const inventoryState = pgEnum("inventory_state", [
  "none",
  "reserved",
  "committed",
  "released",
]);

export const discountType = pgEnum("discount_type", ["percent", "fixed"]);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline"),
    description: text("description").notNull(),
    priceCents: integer("price_cents").notNull(),
    sku: text("sku").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("products_slug_idx").on(t.slug)],
);

export const productImages = pgTable("product_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  alt: text("alt").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const inventory = pgTable("inventory", {
  productId: uuid("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  onHand: integer("on_hand").notNull().default(0),
  reserved: integer("reserved").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const inventoryAdjustments = pgTable("inventory_adjustments", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  adminUserId: text("admin_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const carts = pgTable("carts", {
  id: uuid("id").primaryKey().defaultRandom(),
  // No FK until Plan 2 introduces the Better Auth user table.
  userId: text("user_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const cartItems = pgTable(
  "cart_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
  },
  (t) => [uniqueIndex("cart_items_cart_product_idx").on(t.cartId, t.productId)],
);

export const discountCodes = pgTable(
  "discount_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    type: discountType("type").notNull(),
    value: integer("value").notNull(),
    minSubtotalCents: integer("min_subtotal_cents").notNull().default(0),
    maxRedemptions: integer("max_redemptions"),
    timesRedeemed: integer("times_redeemed").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("discount_codes_code_idx").on(t.code),
    check("discount_codes_code_lowercase", sql`${t.code} = lower(${t.code})`),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNumber: integer("order_number")
      .notNull()
      .generatedByDefaultAsIdentity({ startWith: 1000 }),
    userId: text("user_id"),
    // The cart this order came from, so the webhook can empty it once payment
    // actually succeeds. Nulled rather than cascaded if the cart is deleted —
    // an order must outlive the cart that produced it.
    cartId: uuid("cart_id").references(() => carts.id, { onDelete: "set null" }),
    email: text("email").notNull(),
    status: orderStatus("status").notNull().default("pending"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    discountCodeId: uuid("discount_code_id").references(() => discountCodes.id),

    subtotalCents: integer("subtotal_cents").notNull(),
    discountCents: integer("discount_cents").notNull().default(0),
    shippingCents: integer("shipping_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    refundedCents: integer("refunded_cents").notNull().default(0),

    // .$type is type-only — no migration. Without it every read casts
    // `as Address` with nothing checking the shape.
    shippingAddress: jsonb("shipping_address").$type<Address>().notNull(),
    billingAddress: jsonb("billing_address").$type<Address>(),

    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),

    inventoryState: inventoryState("inventory_state").notNull().default("none"),
    reservationExpiresAt: timestamp("reservation_expires_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    // Set when this order honoured a discount whose redemption cap had already
    // been taken by a concurrent order. The customer was charged the
    // discounted total, so the discount stands — but the overrun is recorded
    // here rather than only logged, so it can be counted and reconciled.
    discountOverrunAt: timestamp("discount_overrun_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("orders_number_idx").on(t.orderNumber),
    uniqueIndex("orders_payment_intent_idx").on(t.stripePaymentIntentId),
    index("orders_email_idx").on(t.email),
    index("orders_status_idx").on(t.status),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    name: text("name").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    quantity: integer("quantity").notNull(),
    totalCents: integer("total_cents").notNull(),
  },
  (t) => [index("order_items_order_id_idx").on(t.orderId)],
);

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Contact form submissions.
 *
 * Rows are written BEFORE the email is sent, so a Resend outage loses nothing
 * and `delivered_at` records whether the send actually landed. The same rows
 * are what the rate limiter counts, so persistence and limiting share one
 * mechanism instead of two.
 */
export const contactMessages = pgTable(
  "contact_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    orderNumber: integer("order_number"),
    message: text("message").notNull(),
    // Hashed, never the raw address: rate limiting only needs equality, and a
    // raw IP is personal data this store has no reason to retain.
    ipHash: text("ip_hash").notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("contact_messages_rate_idx").on(t.ipHash, t.createdAt)],
);

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

export type Product = typeof products.$inferSelect;
export type SavedAddress = typeof addresses.$inferSelect;
export type ProductImage = typeof productImages.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type DiscountCode = typeof discountCodes.$inferSelect;
export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type InventoryState = (typeof inventoryState.enumValues)[number];

export type Address = {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: "US";
  phone?: string;
};
```

- [ ] **Step 3: Create the database client**

Create `src/lib/db/client.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

function createDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  // postgres.js rather than the Neon HTTP driver: inventory reservation needs
  // real multi-statement transactions, which the HTTP driver does not support.
  const client = postgres(connectionString, { max: 10 });

  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

let instance: Db | null = null;

function getDb(): Db {
  instance ??= createDb();
  return instance;
}

/**
 * The shared connection pool, created on first use rather than on import.
 *
 * `next build` imports the module graph of every route to collect its config,
 * so anything read at module scope must be present at build time. Deferring
 * the DATABASE_URL read to the first query keeps it a request-time value: the
 * build needs no database, and a single image can be promoted between
 * environments. A missing url still throws, just on first use rather than on
 * import.
 *
 * The proxy exists so call sites stay `db.select()`. Methods are bound to the
 * real instance so drizzle never sees the proxy as its `this`.
 */
export const db = new Proxy({} as Db, {
  get(_target, prop) {
    const target = getDb();
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
```

- [ ] **Step 4: Create the migration runner**

Create `src/lib/db/migrate.ts`:

```ts
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const client = postgres(url, { max: 1 });
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  await client.end();
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate
```

Expected: A SQL file appears in `drizzle/`, then `Migrations applied.`

- [ ] **Step 6: Write the seed script**

Create `src/lib/db/seed.ts`:

```ts
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./client";
import { products, inventory, productImages } from "./schema";

const SEED = [
  {
    slug: "coldsmoke-edt-50ml",
    name: "Coldsmoke Eau de Toilette",
    tagline: "Cold air. Dark spice.",
    description:
      "A crisp icy opening that burns down into spice, musk, and a wisp of smoke. Bergamot, iced spearmint, and black pepper over cardamom, clary sage, and lavender, settling into dark musk, amber, cedarwood, and smoky vetiver.",
    priceCents: 4500,
    sku: "CS-EDT-50",
    sortOrder: 0,
    onHand: 50,
    image: {
      url: "/images/coldsmoke-fallback-bottle.svg",
      alt: "The Coldsmoke 50 mL bottle, a dark flask with a brushed silver cap, lit from behind against near-black.",
    },
  },
  {
    slug: "coldsmoke-sample-2ml",
    name: "Coldsmoke Sample",
    tagline: "Two millilitres. Enough to decide.",
    description:
      "A 2 mL atomizer of Coldsmoke Eau de Toilette. Roughly twenty sprays — enough to wear it for a few days and learn how it dries down on your skin.",
    priceCents: 600,
    sku: "CS-SMP-2",
    sortOrder: 1,
    onHand: 200,
    image: {
      url: "/images/coldsmoke-fallback-brand.svg",
      alt: "The Coldsmoke brand card: the wordmark over the line “Cold air. Dark spice.”",
    },
  },
];

async function main() {
  for (const item of SEED) {
    const { onHand, image, ...product } = item;
    const [row] = await db
      .insert(products)
      .values(product)
      .onConflictDoUpdate({
        target: products.slug,
        set: { name: product.name, description: product.description },
      })
      .returning();

    await db
      .insert(inventory)
      .values({ productId: row.id, onHand, reserved: 0 })
      .onConflictDoNothing();

    // Replace rather than append. The seed is re-run routinely and
    // product_images has no unique constraint to conflict on, so inserting
    // would stack a duplicate row on every run.
    await db.delete(productImages).where(eq(productImages.productId, row.id));
    await db
      .insert(productImages)
      .values({ productId: row.id, url: image.url, alt: image.alt });

    console.log(`Seeded ${row.slug}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Run the seed and verify**

```bash
npm run db:seed
```

Expected: `Seeded coldsmoke-edt-50ml` and `Seeded coldsmoke-sample-2ml`

- [ ] **Step 8: Commit**

```bash
git add drizzle.config.ts drizzle src/lib/db
git commit -m "feat: database schema, migrations, and product seed data"
```

---

## Task 3: Pricing — the single money calculation

This is the highest-value task in the plan. Every other money path calls this function, and it is pure, so it gets exhaustive table-driven tests.

**Files:**
- Create: `src/lib/pricing/quote.ts`, `src/lib/pricing/quote.test.ts`

**Interfaces:**
- Consumes: nothing (pure module)
- Produces:
  - `FLAT_SHIPPING_CENTS = 600`, `FREE_SHIPPING_THRESHOLD_CENTS = 5000`
  - `type QuoteLine = { productId: string; name: string; unitPriceCents: number; quantity: number }`
  - `type AppliedDiscount = { id: string; code: string; type: "percent" | "fixed"; value: number }`
  - `type Quote = { lines: QuoteLine[]; subtotalCents: number; discountCents: number; shippingCents: number; taxCents: number; totalCents: number }`
  - `quote(lines: QuoteLine[], discount?: AppliedDiscount | null, taxCents?: number): Quote`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/pricing/quote.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  quote,
  FLAT_SHIPPING_CENTS,
  FREE_SHIPPING_THRESHOLD_CENTS,
  type QuoteLine,
  type AppliedDiscount,
} from "./quote";

const bottle: QuoteLine = {
  productId: "p1",
  name: "Coldsmoke Eau de Toilette",
  unitPriceCents: 4500,
  quantity: 1,
};

const sample: QuoteLine = {
  productId: "p2",
  name: "Coldsmoke Sample",
  unitPriceCents: 600,
  quantity: 1,
};

const percent10: AppliedDiscount = {
  id: "d1",
  code: "welcome10",
  type: "percent",
  value: 10,
};

const fixed500: AppliedDiscount = {
  id: "d2",
  code: "five",
  type: "fixed",
  value: 500,
};

describe("quote — subtotal", () => {
  it("sums a single line", () => {
    expect(quote([bottle]).subtotalCents).toBe(4500);
  });

  it("multiplies by quantity", () => {
    expect(quote([{ ...bottle, quantity: 3 }]).subtotalCents).toBe(13500);
  });

  it("sums multiple lines", () => {
    expect(quote([bottle, sample]).subtotalCents).toBe(5100);
  });

  it("returns an all-zero quote for an empty cart", () => {
    const q = quote([]);
    expect(q).toMatchObject({
      subtotalCents: 0,
      discountCents: 0,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
  });
});

describe("quote — shipping threshold", () => {
  it("charges flat shipping below the threshold", () => {
    expect(quote([bottle]).shippingCents).toBe(FLAT_SHIPPING_CENTS);
  });

  it("charges flat shipping one cent below the threshold", () => {
    const line = { ...bottle, unitPriceCents: FREE_SHIPPING_THRESHOLD_CENTS - 1 };
    expect(quote([line]).shippingCents).toBe(FLAT_SHIPPING_CENTS);
  });

  it("gives free shipping exactly at the threshold", () => {
    const line = { ...bottle, unitPriceCents: FREE_SHIPPING_THRESHOLD_CENTS };
    expect(quote([line]).shippingCents).toBe(0);
  });

  it("gives free shipping above the threshold", () => {
    expect(quote([bottle, sample]).shippingCents).toBe(0);
  });

  it("charges no shipping on an empty cart", () => {
    expect(quote([]).shippingCents).toBe(0);
  });
});

describe("quote — discounts", () => {
  it("applies a percentage discount", () => {
    expect(quote([bottle], percent10).discountCents).toBe(450);
  });

  it("applies a fixed discount", () => {
    expect(quote([bottle], fixed500).discountCents).toBe(500);
  });

  it("never discounts more than the subtotal", () => {
    const q = quote([sample], { ...fixed500, value: 10000 });
    expect(q.discountCents).toBe(600);
    // subtotal 600, discount capped at 600 -> discountedSubtotal 0, which is
    // below the free-shipping threshold, so flat shipping applies, tax is 0:
    // total = 0 + 600 + 0 = 600.
    expect(q.totalCents).toBe(600);
  });

  it("rounds a percentage discount to the nearest cent", () => {
    // 5% of 605 = 30.25 -> 30
    const q = quote([{ ...sample, unitPriceCents: 605 }], {
      ...percent10,
      value: 5,
    });
    expect(q.discountCents).toBe(30);
  });

  it("evaluates the free-shipping threshold AFTER the discount", () => {
    // 5100 subtotal - 10% = 4590, which is below 5000, so shipping applies.
    const q = quote([bottle, sample], percent10);
    expect(q.subtotalCents).toBe(5100);
    expect(q.discountCents).toBe(510);
    expect(q.shippingCents).toBe(FLAT_SHIPPING_CENTS);
  });

  it("treats a null discount as no discount", () => {
    expect(quote([bottle], null).discountCents).toBe(0);
  });
});

describe("quote — tax and total", () => {
  it("includes supplied tax in the total", () => {
    const q = quote([bottle], null, 371);
    expect(q.taxCents).toBe(371);
    expect(q.totalCents).toBe(4500 + 600 + 371);
  });

  it("defaults tax to zero", () => {
    expect(quote([bottle]).taxCents).toBe(0);
  });

  it("computes total as subtotal - discount + shipping + tax", () => {
    const q = quote([bottle, sample], percent10, 400);
    expect(q.totalCents).toBe(5100 - 510 + FLAT_SHIPPING_CENTS + 400);
  });
});

describe("quote — invariants", () => {
  it("rejects a negative quantity", () => {
    expect(() => quote([{ ...bottle, quantity: -1 }])).toThrow(
      /quantity must be a positive integer/i,
    );
  });

  it("rejects a fractional quantity", () => {
    expect(() => quote([{ ...bottle, quantity: 1.5 }])).toThrow(
      /quantity must be a positive integer/i,
    );
  });

  it("rejects a non-integer price, guarding against float money", () => {
    expect(() => quote([{ ...bottle, unitPriceCents: 45.5 }])).toThrow(
      /must be an integer number of cents/i,
    );
  });

  it("rejects negative tax", () => {
    expect(() => quote([bottle], null, -1)).toThrow(/tax cannot be negative/i);
  });

  it("returns only integer cents in every field", () => {
    const q = quote([bottle, sample], { ...percent10, value: 7 }, 333);
    for (const value of [
      q.subtotalCents,
      q.discountCents,
      q.shippingCents,
      q.taxCents,
      q.totalCents,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("rejects a negative price", () => {
    expect(() => quote([{ ...bottle, unitPriceCents: -700 }])).toThrow(
      /price must not be negative/i,
    );
  });

  it("accepts a zero price for a free item", () => {
    const q = quote([{ ...bottle, unitPriceCents: 0 }]);
    expect(q.subtotalCents).toBe(0);
  });

  it("does not let the caller's array mutate the returned quote's lines", () => {
    const lines = [{ ...bottle }];
    const q = quote(lines);
    lines.push({ ...sample });
    lines[0].quantity = 99;
    expect(q.lines).toEqual([bottle]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/pricing/quote.test.ts`
Expected: FAIL — `Failed to resolve import "./quote"`

- [ ] **Step 3: Implement the quote function**

Create `src/lib/pricing/quote.ts`:

```ts
export const FLAT_SHIPPING_CENTS = 600;
export const FREE_SHIPPING_THRESHOLD_CENTS = 5000;

export type QuoteLine = {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
};

export type AppliedDiscount = {
  id: string;
  code: string;
  type: "percent" | "fixed";
  value: number;
};

export type Quote = {
  lines: QuoteLine[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
};

/**
 * The single place money is computed. The cart page, PaymentIntent creation,
 * and the Stripe webhook all call this, so they cannot disagree.
 *
 * Pure by design: tax is supplied by the caller (lib/payments fetches it from
 * Stripe Tax) rather than fetched here, so every branch is unit-testable.
 */
export function quote(
  lines: QuoteLine[],
  discount: AppliedDiscount | null = null,
  taxCents = 0,
): Quote {
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(
        `Line ${line.productId}: quantity must be a positive integer`,
      );
    }
    if (!Number.isInteger(line.unitPriceCents)) {
      throw new Error(
        `Line ${line.productId}: price must be an integer number of cents`,
      );
    }
    if (line.unitPriceCents < 0) {
      throw new Error(`Line ${line.productId}: price must not be negative`);
    }
  }
  if (!Number.isInteger(taxCents) || taxCents < 0) {
    throw new Error("Tax cannot be negative and must be integer cents");
  }

  const subtotalCents = lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0,
  );

  const discountCents = computeDiscount(subtotalCents, discount);
  const discountedSubtotal = subtotalCents - discountCents;

  // The free-shipping threshold is evaluated on the post-discount subtotal:
  // a discount should not be able to buy free shipping.
  const shippingCents =
    subtotalCents === 0 || discountedSubtotal >= FREE_SHIPPING_THRESHOLD_CENTS
      ? 0
      : FLAT_SHIPPING_CENTS;

  return {
    lines: lines.map((line) => ({ ...line })),
    subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    totalCents: discountedSubtotal + shippingCents + taxCents,
  };
}

function computeDiscount(
  subtotalCents: number,
  discount: AppliedDiscount | null,
): number {
  if (!discount || subtotalCents === 0) return 0;

  const raw =
    discount.type === "percent"
      ? Math.round((subtotalCents * discount.value) / 100)
      : discount.value;

  // Never discount below zero — a fixed code larger than the cart must not
  // produce a negative total.
  return Math.min(raw, subtotalCents);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/pricing/quote.test.ts`
Expected: PASS — 21 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/lib/pricing
git commit -m "feat: pricing quote as the single money calculation"
```

---

## Task 4: Discount validation

**Files:**
- Create: `src/lib/discounts/validate.ts`, `src/lib/discounts/validate.test.ts`, `src/lib/discounts/index.ts`

**Interfaces:**
- Consumes: `DiscountCode` from `@/lib/db/schema`, `AppliedDiscount` from `@/lib/pricing/quote`
- Produces:
  - `type DiscountResult = { ok: true; discount: AppliedDiscount } | { ok: false; reason: DiscountFailure }`
  - `type DiscountFailure = "not_found" | "inactive" | "not_started" | "expired" | "exhausted" | "below_minimum"`
  - `validateDiscount(code: DiscountCode | null, subtotalCents: number, now?: Date): DiscountResult`
  - `discountFailureMessage(reason: DiscountFailure, code?: DiscountCode): string`
  - `lookupDiscount(rawCode: string): Promise<DiscountCode | null>`
  - `redeemDiscount(tx: Tx, discountCodeId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/discounts/validate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateDiscount, discountFailureMessage } from "./validate";
import type { DiscountCode } from "@/lib/db/schema";

const NOW = new Date("2026-06-15T12:00:00Z");

function code(overrides: Partial<DiscountCode> = {}): DiscountCode {
  return {
    id: "d1",
    code: "welcome10",
    type: "percent",
    value: 10,
    minSubtotalCents: 0,
    maxRedemptions: null,
    timesRedeemed: 0,
    startsAt: null,
    endsAt: null,
    active: true,
    ...overrides,
  } as DiscountCode;
}

describe("validateDiscount", () => {
  it("accepts a valid code", () => {
    const result = validateDiscount(code(), 4500, NOW);
    expect(result).toEqual({
      ok: true,
      discount: { id: "d1", code: "welcome10", type: "percent", value: 10 },
    });
  });

  it("rejects a missing code", () => {
    expect(validateDiscount(null, 4500, NOW)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("rejects an inactive code", () => {
    expect(validateDiscount(code({ active: false }), 4500, NOW)).toEqual({
      ok: false,
      reason: "inactive",
    });
  });

  it("rejects a code that has not started", () => {
    const c = code({ startsAt: new Date("2026-07-01T00:00:00Z") });
    expect(validateDiscount(c, 4500, NOW)).toEqual({
      ok: false,
      reason: "not_started",
    });
  });

  it("accepts a code whose start has passed", () => {
    const c = code({ startsAt: new Date("2026-01-01T00:00:00Z") });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });

  it("rejects an expired code", () => {
    const c = code({ endsAt: new Date("2026-06-01T00:00:00Z") });
    expect(validateDiscount(c, 4500, NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("accepts a code expiring in the future", () => {
    const c = code({ endsAt: new Date("2026-12-31T00:00:00Z") });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });

  it("rejects a code at its redemption cap", () => {
    const c = code({ maxRedemptions: 5, timesRedeemed: 5 });
    expect(validateDiscount(c, 4500, NOW)).toEqual({
      ok: false,
      reason: "exhausted",
    });
  });

  it("accepts a code below its redemption cap", () => {
    const c = code({ maxRedemptions: 5, timesRedeemed: 4 });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });

  it("rejects a subtotal below the minimum", () => {
    const c = code({ minSubtotalCents: 5000 });
    expect(validateDiscount(c, 4500, NOW)).toEqual({
      ok: false,
      reason: "below_minimum",
    });
  });

  it("accepts a subtotal exactly at the minimum", () => {
    const c = code({ minSubtotalCents: 4500 });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });

  it("accepts a code whose startsAt is exactly now", () => {
    const c = code({ startsAt: NOW });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });

  it("accepts a code whose endsAt is exactly now", () => {
    const c = code({ endsAt: NOW });
    expect(validateDiscount(c, 4500, NOW).ok).toBe(true);
  });
});

describe("discountFailureMessage", () => {
  it("explains the minimum in dollars", () => {
    const message = discountFailureMessage(
      "below_minimum",
      code({ minSubtotalCents: 5000 }),
    );
    expect(message).toContain("$50.00");
  });

  it("returns a message for every failure reason", () => {
    const reasons = [
      "not_found",
      "inactive",
      "not_started",
      "expired",
      "exhausted",
    ] as const;
    for (const reason of reasons) {
      expect(discountFailureMessage(reason)).toBeTruthy();
    }
  });

  it("falls back to a generic message when below_minimum has no code", () => {
    expect(discountFailureMessage("below_minimum")).toBe(
      "Your order is below the minimum for that code.",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/discounts/validate.test.ts`
Expected: FAIL — `Failed to resolve import "./validate"`

- [ ] **Step 3: Implement validation**

Create `src/lib/discounts/validate.ts`:

```ts
import type { DiscountCode } from "@/lib/db/schema";
import type { AppliedDiscount } from "@/lib/pricing/quote";
import { formatCents } from "@/lib/money";

export type DiscountFailure =
  | "not_found"
  | "inactive"
  | "not_started"
  | "expired"
  | "exhausted"
  | "below_minimum";

export type DiscountResult =
  | { ok: true; discount: AppliedDiscount }
  | { ok: false; reason: DiscountFailure };

export function validateDiscount(
  code: DiscountCode | null,
  subtotalCents: number,
  now: Date = new Date(),
): DiscountResult {
  if (!code) return { ok: false, reason: "not_found" };
  if (!code.active) return { ok: false, reason: "inactive" };
  if (code.startsAt && code.startsAt > now) {
    return { ok: false, reason: "not_started" };
  }
  if (code.endsAt && code.endsAt < now) {
    return { ok: false, reason: "expired" };
  }
  if (code.maxRedemptions !== null && code.timesRedeemed >= code.maxRedemptions) {
    return { ok: false, reason: "exhausted" };
  }
  if (subtotalCents < code.minSubtotalCents) {
    return { ok: false, reason: "below_minimum" };
  }

  return {
    ok: true,
    discount: {
      id: code.id,
      code: code.code,
      type: code.type,
      value: code.value,
    },
  };
}

export function discountFailureMessage(
  reason: DiscountFailure,
  code?: DiscountCode,
): string {
  switch (reason) {
    case "not_found":
      return "That code isn't valid.";
    case "inactive":
      return "That code is no longer active.";
    case "not_started":
      return "That code isn't active yet.";
    case "expired":
      return "That code has expired.";
    case "exhausted":
      return "That code has been fully redeemed.";
    case "below_minimum":
      return code
        ? `That code needs an order of ${formatCents(code.minSubtotalCents)} or more.`
        : "Your order is below the minimum for that code.";
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/discounts/validate.test.ts`
Expected: PASS — 13 tests passing

- [ ] **Step 5: Add the database-backed lookup and redemption**

Create `src/lib/discounts/index.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { discountCodes, type DiscountCode } from "@/lib/db/schema";

export * from "./validate";

/** Codes are stored and compared lowercase, so entry is case-insensitive. */
export async function lookupDiscount(
  rawCode: string,
): Promise<DiscountCode | null> {
  const normalized = rawCode.trim().toLowerCase();
  if (!normalized) return null;

  const [row] = await db
    .select()
    .from(discountCodes)
    .where(eq(discountCodes.code, normalized))
    .limit(1);

  return row ?? null;
}

/**
 * Increments redemption count, guarded by the cap so a race cannot exceed it.
 * Called from the webhook inside the same transaction that marks an order paid.
 *
 * Returns `true` when the row was updated, `false` when the cap was already
 * exhausted (the UPDATE matched zero rows). This runs after the customer has
 * already been charged and the order's stored total already reflects the
 * discount, so a `false` result means the discount was applied to an order
 * without being recorded here — the caller should log it, not throw: a throw
 * would fail the webhook and trigger Stripe retries for something that must
 * not block order fulfillment.
 */
export async function redeemDiscount(
  tx: Tx,
  discountCodeId: string,
): Promise<boolean> {
  const rows = await tx
    .update(discountCodes)
    .set({ timesRedeemed: sql`${discountCodes.timesRedeemed} + 1` })
    .where(
      sql`${discountCodes.id} = ${discountCodeId} AND (${discountCodes.maxRedemptions} IS NULL OR ${discountCodes.timesRedeemed} < ${discountCodes.maxRedemptions})`,
    )
    .returning({ id: discountCodes.id });

  return rows.length > 0;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/discounts
git commit -m "feat: discount code validation and redemption"
```

---

## Task 5: Catalog reads

**Files:**
- Create: `src/lib/catalog/index.ts`

**Interfaces:**
- Consumes: `db`, `products`, `productImages`, `inventory` from `@/lib/db`
- Produces:
  - `type CatalogProduct = Product & { images: ProductImage[]; available: number }`
  - `getActiveProducts(): Promise<CatalogProduct[]>`
  - `getProductBySlug(slug: string): Promise<CatalogProduct | null>`
  - `getCatalogProductById(id: string): Promise<CatalogProduct | null>`
  - `getProductsByIds(ids: string[]): Promise<Product[]>`

- [ ] **Step 1: Implement the catalog module**

Create `src/lib/catalog/index.ts`:

```ts
import { eq, and, inArray, asc, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  products,
  productImages,
  inventory,
  type Product,
  type ProductImage,
} from "@/lib/db/schema";

export type CatalogProduct = Product & {
  images: ProductImage[];
  /** onHand minus reserved — what a new customer can actually buy. */
  available: number;
};

/**
 * onHand minus reserved, floored at zero. Shared by every catalog read so the
 * three of them cannot drift apart.
 *
 * Postgres GREATEST ignores NULL arguments unless all of them are NULL, so a
 * product with no inventory row — where the leftJoin supplies NULLs — yields
 * 0 rather than NULL. Callers therefore do not need to coalesce the result.
 */
const availableExpr = sql<number>`GREATEST(${inventory.onHand} - ${inventory.reserved}, 0)`;

export async function getActiveProducts(): Promise<CatalogProduct[]> {
  const rows = await db
    .select({
      product: products,
      available: availableExpr,
    })
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .where(eq(products.active, true))
    .orderBy(asc(products.sortOrder));

  if (rows.length === 0) return [];

  const images = await db
    .select()
    .from(productImages)
    .where(
      inArray(
        productImages.productId,
        rows.map((r) => r.product.id),
      ),
    )
    .orderBy(asc(productImages.sortOrder));

  return rows.map((row) => ({
    ...row.product,
    available: Number(row.available),
    images: images.filter((image) => image.productId === row.product.id),
  }));
}

export async function getProductBySlug(
  slug: string,
): Promise<CatalogProduct | null> {
  const [row] = await db
    .select({
      product: products,
      available: availableExpr,
    })
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .where(and(eq(products.slug, slug), eq(products.active, true)))
    .limit(1);

  if (!row) return null;

  const images = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, row.product.id))
    .orderBy(asc(productImages.sortOrder));

  return {
    ...row.product,
    available: Number(row.available),
    images,
  };
}

/**
 * Availability-aware lookup by id. Used by checkout to report exactly how many
 * of a product remain when a reservation fails, so the customer is told which
 * line to fix rather than a generic "something sold out".
 */
export async function getCatalogProductById(
  id: string,
): Promise<CatalogProduct | null> {
  const [row] = await db
    .select({
      product: products,
      available: availableExpr,
    })
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .where(eq(products.id, id))
    .limit(1);

  if (!row) return null;

  const images = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, row.product.id))
    .orderBy(asc(productImages.sortOrder));

  return { ...row.product, available: Number(row.available), images };
}

/** Used to resolve live prices for cart lines. */
export async function getProductsByIds(ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  return db.select().from(products).where(inArray(products.id, ids));
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/catalog
git commit -m "feat: catalog reads with live availability"
```

---

## Task 6: Inventory with concurrency safety

The concurrency test here is the reason this module exists as its own unit. It requires a real Postgres, so start the test database first.

**Files:**
- Create: `src/lib/inventory/index.ts`, `src/lib/inventory/inventory.test.ts`, `src/test/db.ts`

**Interfaces:**
- Consumes: `Tx` from `@/lib/db/client`, `inventory` / `orders` / `orderItems` from `@/lib/db/schema`
- Produces:
  - `class OutOfStockError extends Error { productId: string }`
  - `RESERVATION_WINDOW_MS = 15 * 60 * 1000`
  - `reserveStock(tx: Tx, items: { productId: string; quantity: number }[]): Promise<void>`
  - `commitStock(tx: Tx, orderId: string): Promise<void>`
  - `releaseStock(tx: Tx, orderId: string): Promise<void>`
  - `releaseExpiredReservations(): Promise<number>`
  - Test helper `testDb()` from `@/test/db`

- [ ] **Step 1: Create the test database helper**

Create `src/test/db.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";

/**
 * Connects to the throwaway Postgres from docker-compose.test.yml and applies
 * migrations. Integration tests need a real database — reservation races and
 * transaction rollback cannot be proven against a mock.
 */
export async function testDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set. Run npm run db:test:up");

  const client = postgres(url, { max: 5 });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });

  return {
    db,
    async truncate() {
      await client`
        TRUNCATE order_items, orders, cart_items, carts, inventory_adjustments,
                 inventory, product_images, products, discount_codes, stripe_events,
                 contact_messages, addresses, session, account, verification, "user"
        RESTART IDENTITY CASCADE`;
    },
    async close() {
      await client.end();
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/inventory/inventory.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testDb } from "@/test/db";
import { products, inventory, orders, orderItems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  reserveStock,
  commitStock,
  releaseStock,
  releaseExpiredReservations,
  OutOfStockError,
} from "./index";

let ctx: Awaited<ReturnType<typeof testDb>>;
let productId: string;

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US" as const,
};

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  const [product] = await ctx.db
    .insert(products)
    .values({
      slug: "test-edt",
      name: "Test EDT",
      description: "Test",
      priceCents: 4500,
      sku: "T-1",
    })
    .returning();
  productId = product.id;
  await ctx.db
    .insert(inventory)
    .values({ productId, onHand: 2, reserved: 0 });
});

async function createOrder(quantity: number) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      subtotalCents: 4500 * quantity,
      totalCents: 4500 * quantity,
      shippingAddress: ADDRESS,
    })
    .returning();

  await ctx.db.insert(orderItems).values({
    orderId: order.id,
    productId,
    name: "Test EDT",
    unitPriceCents: 4500,
    quantity,
    totalCents: 4500 * quantity,
  });

  return order.id;
}

async function stock() {
  const [row] = await ctx.db
    .select()
    .from(inventory)
    .where(eq(inventory.productId, productId));
  return row;
}

describe("reserveStock", () => {
  it("increments reserved without changing onHand", async () => {
    await ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 1 }]));
    expect(await stock()).toMatchObject({ onHand: 2, reserved: 1 });
  });

  it("allows reserving all available stock", async () => {
    await ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 2 }]));
    expect(await stock()).toMatchObject({ onHand: 2, reserved: 2 });
  });

  it("throws OutOfStockError when requesting more than available", async () => {
    await expect(
      ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 3 }])),
    ).rejects.toBeInstanceOf(OutOfStockError);
  });

  it("leaves stock untouched when a multi-line reservation fails", async () => {
    await expect(
      ctx.db.transaction((tx) =>
        reserveStock(tx, [
          { productId, quantity: 1 },
          { productId, quantity: 5 },
        ]),
      ),
    ).rejects.toBeInstanceOf(OutOfStockError);

    // The whole transaction rolled back — no partial reservation survived.
    expect(await stock()).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it("lets exactly one of two concurrent buyers take the last unit", async () => {
    await ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 1 }]));

    const results = await Promise.allSettled([
      ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 1 }])),
      ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 1 }])),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await stock()).toMatchObject({ onHand: 2, reserved: 2 });
  });

  // The two-buyer test above relies on incidental event-loop interleaving to
  // create overlap. It's stable in practice, but a naive read-then-write
  // implementation could theoretically pass if the two transactions happened
  // to serialize. Raising the contention (12 racers over 5 units) makes
  // serialization vanishingly unlikely, so this asserts the invariant that
  // actually matters: never more reservations than stock, under real load.
  it("never reserves more than stock exists under high contention", async () => {
    await ctx.db
      .update(inventory)
      .set({ onHand: 5 })
      .where(eq(inventory.productId, productId));

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        ctx.db.transaction((tx) => reserveStock(tx, [{ productId, quantity: 1 }])),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof OutOfStockError,
    );

    expect(fulfilled).toHaveLength(5);
    expect(rejected).toHaveLength(7);
    expect(await stock()).toMatchObject({ onHand: 5, reserved: 5 });
  });
});

describe("commitStock", () => {
  it("decrements onHand and reserved together", async () => {
    const orderId = await createOrder(1);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 1 }]);
      await tx
        .update(orders)
        .set({ inventoryState: "reserved" })
        .where(eq(orders.id, orderId));
    });

    await ctx.db.transaction((tx) => commitStock(tx, orderId));
    expect(await stock()).toMatchObject({ onHand: 1, reserved: 0 });
  });

  it("is idempotent — a replayed webhook decrements once", async () => {
    const orderId = await createOrder(1);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 1 }]);
      await tx
        .update(orders)
        .set({ inventoryState: "reserved" })
        .where(eq(orders.id, orderId));
    });

    await ctx.db.transaction((tx) => commitStock(tx, orderId));
    await ctx.db.transaction((tx) => commitStock(tx, orderId));

    expect(await stock()).toMatchObject({ onHand: 1, reserved: 0 });
  });
});

describe("releaseStock", () => {
  it("returns reserved units without touching onHand", async () => {
    const orderId = await createOrder(2);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 2 }]);
      await tx
        .update(orders)
        .set({ inventoryState: "reserved" })
        .where(eq(orders.id, orderId));
    });

    await ctx.db.transaction((tx) => releaseStock(tx, orderId));
    expect(await stock()).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it("is idempotent", async () => {
    const orderId = await createOrder(1);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 1 }]);
      await tx
        .update(orders)
        .set({ inventoryState: "reserved" })
        .where(eq(orders.id, orderId));
    });

    await ctx.db.transaction((tx) => releaseStock(tx, orderId));
    await ctx.db.transaction((tx) => releaseStock(tx, orderId));

    expect(await stock()).toMatchObject({ onHand: 2, reserved: 0 });
  });

  it("does not release an order that was already committed", async () => {
    const orderId = await createOrder(1);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 1 }]);
      await tx
        .update(orders)
        .set({ inventoryState: "reserved" })
        .where(eq(orders.id, orderId));
    });

    await ctx.db.transaction((tx) => commitStock(tx, orderId));
    await ctx.db.transaction((tx) => releaseStock(tx, orderId));

    expect(await stock()).toMatchObject({ onHand: 1, reserved: 0 });
  });
});

describe("releaseExpiredReservations", () => {
  it("does not cancel an order the webhook already marked paid mid-sweep", async () => {
    const orderId = await createOrder(1);
    await ctx.db.transaction(async (tx) => {
      await reserveStock(tx, [{ productId, quantity: 1 }]);
      await tx
        .update(orders)
        .set({
          inventoryState: "reserved",
          reservationExpiresAt: new Date(Date.now() - 1000),
        })
        .where(eq(orders.id, orderId));
    });

    // Force a real overlap rather than hoping for incidental interleaving:
    // hold the webhook's transaction open after it writes (commit + paid)
    // but before it commits. The sweep's outer SELECT is a separate read, so
    // under READ COMMITTED it still sees the pre-webhook committed state
    // (pending/reserved) and picks the order up as a candidate. The sweep's
    // per-order UPDATE then contends for the same row the webhook already
    // holds a lock on, blocks until the webhook commits, and — per Postgres's
    // EvalPlanQual re-evaluation — re-checks its WHERE clause against the
    // now-committed row and finds it no longer matches "reserved". This
    // reproduces the production race deterministically.
    let releaseHold: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let webhookReady: () => void;
    const webhookIsReady = new Promise<void>((resolve) => {
      webhookReady = resolve;
    });

    const webhookPromise = ctx.db.transaction(async (tx) => {
      await commitStock(tx, orderId);
      await tx
        .update(orders)
        .set({ status: "paid" })
        .where(eq(orders.id, orderId));
      webhookReady();
      await held;
    });

    await webhookIsReady;
    const releasePromise = releaseExpiredReservations(ctx.db);
    // Give the sweep's outer SELECT (and its per-order transaction's UPDATE
    // attempt, which will now block on the webhook's row lock) time to reach
    // Postgres before we let the webhook commit. This is not a race we're
    // hoping to win — the webhook is held open deterministically until we
    // call releaseHold(); the delay just guarantees the sweep's read happens
    // against the pre-commit (still pending) snapshot instead of depending on
    // which of two just-dispatched network requests the driver flushes first.
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseHold!();
    const [cancelledCount] = await Promise.all([releasePromise, webhookPromise]);

    const [order] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId));

    expect(order.status).toBe("paid");
    expect(cancelledCount).toBe(0);
    expect(await stock()).toMatchObject({ onHand: 1, reserved: 0 });
  });
});
```

- [ ] **Step 3: Start the test database and run the tests to verify they fail**

```bash
npm run db:test:up
npm test -- src/lib/inventory
```

Expected: FAIL — `Failed to resolve import "./index"`

- [ ] **Step 4: Implement the inventory module**

Create `src/lib/inventory/index.ts`:

```ts
import { and, eq, lt, sql } from "drizzle-orm";
import { db, type Db, type Tx } from "@/lib/db/client";
import { inventory, orders, orderItems } from "@/lib/db/schema";

export const RESERVATION_WINDOW_MS = 15 * 60 * 1000;

export class OutOfStockError extends Error {
  constructor(public readonly productId: string) {
    super(`Out of stock: ${productId}`);
    this.name = "OutOfStockError";
  }
}

/**
 * Reserves stock for a set of lines. The guard lives in the WHERE clause, so
 * Postgres decides the winner of a race between two buyers — the read and the
 * write are one atomic statement, with no gap to lose.
 *
 * Must be called inside a transaction: a failure on any line rolls back the
 * reservations already made for earlier lines.
 */
export async function reserveStock(
  tx: Tx,
  items: { productId: string; quantity: number }[],
): Promise<void> {
  for (const item of items) {
    const updated = await tx
      .update(inventory)
      .set({
        reserved: sql`${inventory.reserved} + ${item.quantity}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventory.productId, item.productId),
          sql`${inventory.onHand} - ${inventory.reserved} >= ${item.quantity}`,
        ),
      )
      .returning({ productId: inventory.productId });

    if (updated.length === 0) {
      throw new OutOfStockError(item.productId);
    }
  }
}

/**
 * Converts a reservation into a sale. Guarded on inventoryState so a replayed
 * Stripe webhook cannot decrement stock twice.
 */
export async function commitStock(tx: Tx, orderId: string): Promise<void> {
  const claimed = await claimInventoryState(tx, orderId, "reserved", "committed");
  if (!claimed) return;

  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  for (const item of items) {
    await tx
      .update(inventory)
      .set({
        onHand: sql`${inventory.onHand} - ${item.quantity}`,
        reserved: sql`GREATEST(${inventory.reserved} - ${item.quantity}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(inventory.productId, item.productId));
  }
}

/**
 * Returns reserved units to the available pool. Idempotent.
 *
 * @returns true if the reservation was actually released (the order was
 *   still in the "reserved" inventory state), false if there was nothing to
 *   do — e.g. the order was already committed or released by another
 *   caller. Callers that conditionally act on the release (such as
 *   cancelling the order) must check this before doing so.
 */
export async function releaseStock(tx: Tx, orderId: string): Promise<boolean> {
  const claimed = await claimInventoryState(tx, orderId, "reserved", "released");
  if (!claimed) return false;

  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  for (const item of items) {
    await tx
      .update(inventory)
      .set({
        reserved: sql`GREATEST(${inventory.reserved} - ${item.quantity}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(inventory.productId, item.productId));
  }

  return true;
}

/**
 * Atomically moves an order from one inventory state to another. Returns false
 * if the order was not in the expected state, which is how idempotency is
 * enforced: the second caller finds nothing to claim and does nothing.
 */
async function claimInventoryState(
  tx: Tx,
  orderId: string,
  from: "reserved",
  to: "committed" | "released",
): Promise<boolean> {
  const rows = await tx
    .update(orders)
    .set({ inventoryState: to })
    .where(and(eq(orders.id, orderId), eq(orders.inventoryState, from)))
    .returning({ id: orders.id });

  return rows.length > 0;
}

/**
 * Releases reservations for pending orders past their expiry window, so an
 * abandoned checkout does not hold a bottle forever. Called by the cron route
 * and lazily before reservation-sensitive reads.
 *
 * The candidate list is selected outside any transaction, so an order can
 * change state (e.g. a Stripe webhook committing it to "paid") in the gap
 * between that SELECT and this function reaching it. Each order is therefore
 * only cancelled if `releaseStock` actually released it — and the status
 * write is additionally guarded on `status = "pending"` as a second line of
 * defence, so a stale candidate can never clobber a non-pending order.
 */
export async function releaseExpiredReservations(database: Db = db): Promise<number> {
  const expired = await database
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "pending"),
        eq(orders.inventoryState, "reserved"),
        lt(orders.reservationExpiresAt, new Date()),
      ),
    );

  let cancelledCount = 0;

  for (const order of expired) {
    await database.transaction(async (tx) => {
      const released = await releaseStock(tx, order.id);
      if (!released) return;

      const cancelled = await tx
        .update(orders)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
        .returning({ id: orders.id });

      if (cancelled.length > 0) cancelledCount++;
    });
  }

  return cancelledCount;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test -- src/lib/inventory
```

Expected: PASS — 9 tests passing, including the concurrency test.

If the concurrency test is flaky, it is telling you something real: the guard
must live in the `WHERE` clause of a single `UPDATE`. Any version that reads
availability first and then writes has a gap between the two where the other
buyer can win, and both will oversell.

- [ ] **Step 6: Commit**

```bash
git add src/lib/inventory src/test
git commit -m "feat: transactional inventory with reservation expiry"
```

---

## Task 7: Cart identity and line management

**Files:**
- Create: `src/lib/cookies.ts`, `src/lib/cart/limits.ts`, `src/lib/cart/index.ts`, `src/lib/cart/cart.test.ts`

**Interfaces:**
- Consumes: `db`, `carts`, `cartItems`, `getProductsByIds`, `quote`
- Produces:
  - `CART_COOKIE = "cs_cart"`
  - `getCartId(): Promise<string | null>` (read-only — safe in Server Components)
  - `getOrCreateCartId(): Promise<string>` (writes the cookie — Server Actions and Route Handlers ONLY)
  - `getCartLines(cartId: string): Promise<QuoteLine[]>`
  - `addItem(cartId: string, productId: string, quantity: number): Promise<void>`
  - `setQuantity(cartId: string, productId: string, quantity: number): Promise<void>`
  - `clearCart(cartId: string): Promise<void>`

- [ ] **Step 0: Create the cookie-name module**

A `"use server"` file may export **only async functions** — Next.js rejects a
plain `const` export from a server-action module at build time. Cookie names
therefore live in their own module, created here because `CART_COOKIE` is the
first of them to be needed.

Create `src/lib/cookies.ts`:

```ts
/**
 * Cookie names live here rather than beside the actions that read them.
 *
 * A `"use server"` module may export only async functions — Next.js rejects a
 * plain `const` export from a server-action file at build time — so any name
 * shared between an action and a Server Component needs a neutral home.
 */
export const CART_COOKIE = "cs_cart";
export const DISCOUNT_COOKIE = "cs_discount";
export const PENDING_ORDER_COOKIE = "cs_pending_order";

/**
 * Orders this browser is allowed to view, as a comma-separated list of order
 * ids. The id is a v4 UUID, so the cookie value IS the credential — a cookie
 * naming an order by its customer-facing number would be trivially forgeable,
 * since httpOnly stops page scripts but not a hand-written request.
 */
export const ORDER_ACCESS_COOKIE = "cs_order_access";
```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/cart/cart.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { products, carts } from "@/lib/db/schema";

// The cart module reads cookies via next/headers; the line helpers under test
// take an explicit cartId, so only the client import needs stubbing.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { addItem, setQuantity, getCartLines, clearCart } = await import("./index");

let cartId: string;
let bottleId: string;

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();

  const [bottle] = await ctx.db
    .insert(products)
    .values({
      slug: "edt",
      name: "Coldsmoke Eau de Toilette",
      description: "d",
      priceCents: 4500,
      sku: "CS-1",
    })
    .returning();
  bottleId = bottle.id;

  const [cart] = await ctx.db.insert(carts).values({}).returning();
  cartId = cart.id;
});

describe("cart lines", () => {
  it("starts empty", async () => {
    expect(await getCartLines(cartId)).toEqual([]);
  });

  it("adds an item with live price and name from the product", async () => {
    await addItem(cartId, bottleId, 1);
    expect(await getCartLines(cartId)).toEqual([
      {
        productId: bottleId,
        name: "Coldsmoke Eau de Toilette",
        unitPriceCents: 4500,
        quantity: 1,
      },
    ]);
  });

  it("sums quantity when the same product is added twice", async () => {
    await addItem(cartId, bottleId, 1);
    await addItem(cartId, bottleId, 2);
    const lines = await getCartLines(cartId);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(3);
  });

  it("reflects a price change, because carts store no price", async () => {
    await addItem(cartId, bottleId, 1);
    await ctx.db.update(products).set({ priceCents: 4900 });
    const [line] = await getCartLines(cartId);
    expect(line.unitPriceCents).toBe(4900);
  });

  it("updates quantity", async () => {
    await addItem(cartId, bottleId, 1);
    await setQuantity(cartId, bottleId, 4);
    expect((await getCartLines(cartId))[0].quantity).toBe(4);
  });

  it("removes the line when quantity is set to zero", async () => {
    await addItem(cartId, bottleId, 2);
    await setQuantity(cartId, bottleId, 0);
    expect(await getCartLines(cartId)).toEqual([]);
  });

  it("rejects a negative quantity", async () => {
    await expect(setQuantity(cartId, bottleId, -1)).rejects.toThrow(
      /quantity cannot be negative/i,
    );
  });

  it("clears every line", async () => {
    await addItem(cartId, bottleId, 2);
    await clearCart(cartId);
    expect(await getCartLines(cartId)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/cart`
Expected: FAIL — `Failed to resolve import "./index"`

- [ ] **Step 2b: Extract the quantity limit to its own module**

Create `src/lib/cart/limits.ts`:

```ts
/**
 * Cart limits, kept free of server-only imports.
 *
 * `@/lib/cart` pulls in next/headers and the Postgres client, so a Client
 * Component importing a constant from it drags fs/net/tls and the database
 * driver into the browser bundle and the build fails. Same reason
 * `src/lib/cookies.ts` exists.
 */

/**
 * Per-line ceiling shared by the quantity controls and the actions that write
 * them. cart_items.quantity is int4 with no CHECK constraint, so an unbounded
 * value would eventually overflow on the `quantity + n` upsert in addItem.
 */
export const MAX_LINE_QUANTITY = 99;
```

- [ ] **Step 3: Implement the cart module**

Create `src/lib/cart/index.ts`:

```ts
import { cookies } from "next/headers";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { carts, cartItems } from "@/lib/db/schema";
import { getProductsByIds } from "@/lib/catalog";
import type { QuoteLine } from "@/lib/pricing/quote";
import { CART_COOKIE } from "@/lib/cookies";

export { CART_COOKIE };

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export { MAX_LINE_QUANTITY } from "./limits";

/**
 * Reads the caller's cart id without creating one. Safe to call while
 * rendering a Server Component.
 *
 * Next.js only permits cookies().set() inside a Server Action or Route
 * Handler — calling it during render throws. Pages and layouts must therefore
 * use this read-only path, and only mutations may create a cart.
 */
export async function getCartId(): Promise<string | null> {
  const jar = await cookies();
  const existing = jar.get(CART_COOKIE)?.value;
  if (!existing) return null;

  const [found] = await db
    .select({ id: carts.id })
    .from(carts)
    .where(eq(carts.id, existing))
    .limit(1);

  return found?.id ?? null;
}

/**
 * Resolves the caller's cart, creating one if needed. Guest carts are
 * identified by a uuid in an httpOnly cookie; `mergeGuestCart` in ./merge
 * attaches userId and folds a guest cart into the customer's on sign-in.
 *
 * WRITES A COOKIE — callable only from a Server Action or Route Handler.
 * Server Components must use getCartId() instead.
 */
export async function getOrCreateCartId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(CART_COOKIE)?.value;

  if (existing) {
    const [found] = await db
      .select({ id: carts.id })
      .from(carts)
      .where(eq(carts.id, existing))
      .limit(1);
    if (found) return found.id;
  }

  const [created] = await db.insert(carts).values({}).returning({ id: carts.id });

  jar.set(CART_COOKIE, created.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });

  return created.id;
}

/**
 * Returns cart lines priced from the products table right now. Cart rows store
 * only quantity, so a week-old cart can never lock in a stale price.
 */
export async function getCartLines(cartId: string): Promise<QuoteLine[]> {
  const items = await db
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId));

  if (items.length === 0) return [];

  const catalog = await getProductsByIds(items.map((i) => i.productId));
  const byId = new Map(catalog.map((p) => [p.id, p]));

  return items.flatMap((item) => {
    const product = byId.get(item.productId);
    if (!product || !product.active) return [];
    return [
      {
        productId: product.id,
        name: product.name,
        unitPriceCents: product.priceCents,
        quantity: item.quantity,
      },
    ];
  });
}

export async function addItem(
  cartId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Quantity must be a positive integer");
  }

  await db
    .insert(cartItems)
    .values({ cartId, productId, quantity })
    .onConflictDoUpdate({
      target: [cartItems.cartId, cartItems.productId],
      set: { quantity: sql`${cartItems.quantity} + ${quantity}` },
    });

  await touch(cartId);
}

export async function setQuantity(
  cartId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error("Quantity cannot be negative");
  }

  if (quantity === 0) {
    await db
      .delete(cartItems)
      .where(
        and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)),
      );
  } else {
    await db
      .update(cartItems)
      .set({ quantity })
      .where(
        and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId)),
      );
  }

  await touch(cartId);
}

export async function clearCart(cartId: string): Promise<void> {
  await db.delete(cartItems).where(eq(cartItems.cartId, cartId));
  await touch(cartId);
}

async function touch(cartId: string): Promise<void> {
  await db
    .update(carts)
    .set({ updatedAt: new Date() })
    .where(eq(carts.id, cartId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/cart`
Expected: PASS — 8 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/lib/cart
git commit -m "feat: cart identity and line management"
```

---

## Task 8: Payments adapter — interface, Stripe implementation, and fake

**Files:**
- Create: `src/lib/payments/types.ts`, `src/lib/payments/stripe.ts`, `src/lib/payments/fake.ts`, `src/lib/payments/index.ts`

**Interfaces:**
- Consumes: `Address` from `@/lib/db/schema`, `QuoteLine` from `@/lib/pricing/quote`
- Produces:
  - `type TaxCalculation = { taxCents: number; calculationId: string | null }`
  - `type IntentResult = { paymentIntentId: string; clientSecret: string }`
  - `interface PaymentsAdapter { calculateTax; createOrUpdateIntent; refund; verifyWebhook }`
  - `getPayments(): PaymentsAdapter`
  - `FakePayments` class for tests

- [ ] **Step 1: Define the adapter interface**

Create `src/lib/payments/types.ts`:

```ts
import type { Address } from "@/lib/db/schema";
import type { QuoteLine } from "@/lib/pricing/quote";

export type TaxCalculation = {
  taxCents: number;
  calculationId: string | null;
};

export type IntentResult = {
  paymentIntentId: string;
  clientSecret: string;
};

export type WebhookEvent = {
  id: string;
  type: string;
  paymentIntentId: string | null;
  amountCents: number | null;
  metadata: Record<string, string>;
};

/**
 * The boundary around Stripe. Every other module depends on this interface, so
 * tests substitute FakePayments and run with no network access.
 */
/**
 * Thrown when a PaymentIntent can no longer be modified because it reached a
 * terminal state — typically the order was already paid. Callers should treat
 * this as "this order is finished", not as a retryable failure.
 */
export class PaymentIntentNotUpdatableError extends Error {
  constructor(
    public readonly paymentIntentId: string,
    public readonly status: string,
  ) {
    super(`PaymentIntent ${paymentIntentId} is ${status} and cannot be updated`);
    this.name = "PaymentIntentNotUpdatableError";
  }
}

export interface PaymentsAdapter {
  calculateTax(args: {
    lines: QuoteLine[];
    shippingCents: number;
    discountCents: number;
    address: Address;
  }): Promise<TaxCalculation>;

  createOrUpdateIntent(args: {
    paymentIntentId: string | null;
    amountCents: number;
    email: string;
    orderId: string;
    orderNumber: number;
  }): Promise<IntentResult>;

  refund(args: {
    paymentIntentId: string;
    amountCents: number;
    /**
     * Stable per logical refund. Two submits of the same refund send the same
     * key, so Stripe returns the original refund instead of issuing a second
     * one or rejecting the amount as exceeding what is left.
     */
    idempotencyKey: string;
  }): Promise<{ refundId: string }>;

  verifyWebhook(rawBody: string, signature: string): WebhookEvent;
}
```

- [ ] **Step 2: Implement the Stripe adapter**

Create `src/lib/payments/stripe.ts`:

```ts
import Stripe from "stripe";
import type {
  PaymentsAdapter,
  TaxCalculation,
  IntentResult,
  WebhookEvent,
} from "./types";
import { PaymentIntentNotUpdatableError } from "./types";

const TERMINAL_INTENT_STATUSES = new Set(["succeeded", "canceled", "processing"]);

// This is the ONLY file permitted to import the stripe package.
let stripeClient: Stripe | null = null;

/**
 * Built on first use, not on import. The Stripe constructor throws on a falsy
 * key, and `next build` imports this module's graph to collect route config —
 * so constructing at module scope would make STRIPE_SECRET_KEY a build-time
 * requirement. See the note on `db` in lib/db/client.ts.
 */
function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    stripeClient = new Stripe(key, { apiVersion: "2026-08-26.dahlia" });
  }
  return stripeClient;
}

export class StripePayments implements PaymentsAdapter {
  async calculateTax({
    lines,
    shippingCents,
    discountCents,
    address,
  }: Parameters<PaymentsAdapter["calculateTax"]>[0]): Promise<TaxCalculation> {
    const subtotal = lines.reduce(
      (sum, l) => sum + l.unitPriceCents * l.quantity,
      0,
    );

    const calculation = await getStripe().tax.calculations.create({
      currency: "usd",
      customer_details: {
        address: {
          line1: address.line1,
          line2: address.line2,
          city: address.city,
          state: address.state,
          postal_code: address.postalCode,
          country: "US",
        },
        address_source: "shipping",
      },
      line_items: [
        {
          amount: subtotal - discountCents,
          reference: "cart",
          tax_behavior: "exclusive",
          tax_code: "txcd_30060006", // Cosmetics and personal care
        },
      ],
      shipping_cost: { amount: shippingCents, tax_behavior: "exclusive" },
    });

    return {
      taxCents: calculation.tax_amount_exclusive,
      calculationId: calculation.id ?? null,
    };
  }

  async createOrUpdateIntent({
    paymentIntentId,
    amountCents,
    email,
    orderId,
    orderNumber,
  }: Parameters<
    PaymentsAdapter["createOrUpdateIntent"]
  >[0]): Promise<IntentResult> {
    const metadata = { orderId, orderNumber: String(orderNumber) };

    let intent: Stripe.PaymentIntent;
    if (paymentIntentId) {
      const existing = await getStripe().paymentIntents.retrieve(paymentIntentId);
      if (TERMINAL_INTENT_STATUSES.has(existing.status)) {
        // Do NOT fall back to creating a replacement intent here. If the
        // original already succeeded, the customer has paid; quietly minting
        // a second intent invites a double charge. Callers must treat this
        // as terminal, not retryable.
        throw new PaymentIntentNotUpdatableError(paymentIntentId, existing.status);
      }
      intent = await getStripe().paymentIntents.update(paymentIntentId, {
        amount: amountCents,
        receipt_email: email,
        metadata,
      });
    } else {
      intent = await getStripe().paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        receipt_email: email,
        metadata,
        automatic_payment_methods: { enabled: true },
      });
    }

    return {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret!,
    };
  }

  async refund({
    paymentIntentId,
    amountCents,
    idempotencyKey,
  }: Parameters<PaymentsAdapter["refund"]>[0]) {
    const refund = await getStripe().refunds.create(
      { payment_intent: paymentIntentId, amount: amountCents },
      { idempotencyKey },
    );
    return { refundId: refund.id };
  }

  verifyWebhook(rawBody: string, signature: string): WebhookEvent {
    const event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );

    const object = event.data.object as unknown as Record<string, unknown>;
    const paymentIntentId =
      event.type.startsWith("payment_intent.")
        ? (object.id as string)
        : ((object.payment_intent as string) ?? null);

    // For a refund event, the charge's `amount` is its original total, not
    // what was refunded. `amount_refunded` is the actual refunded amount.
    const amountField =
      event.type === "charge.refunded" ? object.amount_refunded : object.amount;

    return {
      id: event.id,
      type: event.type,
      paymentIntentId,
      amountCents: typeof amountField === "number" ? amountField : null,
      metadata: (object.metadata as Record<string, string>) ?? {},
    };
  }
}
```

- [ ] **Step 3: Implement the fake adapter**

Create `src/lib/payments/fake.ts`:

```ts
import type {
  PaymentsAdapter,
  TaxCalculation,
  IntentResult,
  WebhookEvent,
} from "./types";
import { PaymentIntentNotUpdatableError } from "./types";

const TERMINAL_INTENT_STATUSES = new Set(["succeeded", "canceled", "processing"]);

type FakeIntent = { amountCents: number; orderId: string; status: string };

/**
 * In-memory adapter for tests. Tax is a flat 8% of the taxable base so
 * assertions stay predictable.
 */
export class FakePayments implements PaymentsAdapter {
  public intents = new Map<string, FakeIntent>();
  public refunds: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
  }[] = [];
  private counter = 0;

  async calculateTax({
    lines,
    shippingCents,
    discountCents,
  }: Parameters<PaymentsAdapter["calculateTax"]>[0]): Promise<TaxCalculation> {
    const subtotal = lines.reduce(
      (sum, l) => sum + l.unitPriceCents * l.quantity,
      0,
    );
    const base = subtotal - discountCents + shippingCents;
    return { taxCents: Math.round(base * 0.08), calculationId: "taxcalc_fake" };
  }

  async createOrUpdateIntent({
    paymentIntentId,
    amountCents,
    orderId,
  }: Parameters<
    PaymentsAdapter["createOrUpdateIntent"]
  >[0]): Promise<IntentResult> {
    if (paymentIntentId) {
      const existing = this.intents.get(paymentIntentId);
      if (existing && TERMINAL_INTENT_STATUSES.has(existing.status)) {
        // Mirrors StripePayments: do NOT fall back to creating a replacement
        // intent here. If the original already succeeded, the customer has
        // paid; quietly minting a second intent invites a double charge.
        throw new PaymentIntentNotUpdatableError(paymentIntentId, existing.status);
      }
    }

    const id = paymentIntentId ?? `pi_fake_${++this.counter}`;
    const status = this.intents.get(id)?.status ?? "requires_payment_method";
    this.intents.set(id, { amountCents, orderId, status });
    return { paymentIntentId: id, clientSecret: `${id}_secret` };
  }

  /** Test helper: flips an intent's status to "succeeded" so tests can set
   * up the terminal-state scenario. */
  markSucceeded(paymentIntentId: string): void {
    const existing = this.intents.get(paymentIntentId);
    if (!existing) {
      throw new Error(`No fake intent ${paymentIntentId} to mark succeeded`);
    }
    existing.status = "succeeded";
  }

  async refund({
    paymentIntentId,
    amountCents,
    idempotencyKey,
  }: Parameters<PaymentsAdapter["refund"]>[0]) {
    // Mirrors Stripe: a repeated key returns the original refund rather than
    // creating a second one. Without this the fake would happily record two
    // refunds for a double submit and the tests would not catch a real one.
    const seen = this.refunds.findIndex(
      (r) => r.idempotencyKey === idempotencyKey,
    );
    if (seen !== -1) return { refundId: `re_fake_${seen + 1}` };

    this.refunds.push({ paymentIntentId, amountCents, idempotencyKey });
    return { refundId: `re_fake_${this.refunds.length}` };
  }

  verifyWebhook(rawBody: string): WebhookEvent {
    return JSON.parse(rawBody) as WebhookEvent;
  }

  /** Test helper: builds a webhook payload this adapter will accept. */
  succeededEvent(paymentIntentId: string, eventId = "evt_fake_1"): string {
    const intent = this.intents.get(paymentIntentId);
    return JSON.stringify({
      id: eventId,
      type: "payment_intent.succeeded",
      paymentIntentId,
      amountCents: intent?.amountCents ?? 0,
      metadata: { orderId: intent?.orderId ?? "" },
    } satisfies WebhookEvent);
  }
}
```

- [ ] **Step 4: Add the module entry point**

Create `src/lib/payments/index.ts`:

```ts
import type { PaymentsAdapter } from "./types";
import { StripePayments } from "./stripe";

export * from "./types";

let instance: PaymentsAdapter | null = null;

export function getPayments(): PaymentsAdapter {
  if (!instance) instance = new StripePayments();
  return instance;
}

/** Test seam — lets integration tests install FakePayments. */
export function setPayments(adapter: PaymentsAdapter): void {
  instance = adapter;
}
```

- [ ] **Step 5: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: No errors. If the Stripe `apiVersion` string is rejected, set it to the version the installed SDK's types expect.

- [ ] **Step 6: Commit**

```bash
git add src/lib/payments
git commit -m "feat: payments adapter with Stripe implementation and test fake"
```

---

## Task 9: Orders — creation and the paid transition

**Files:**
- Create: `src/lib/orders/index.ts`, `src/lib/orders/orders.test.ts`

**Interfaces:**
- Consumes: `quote`, `reserveStock`, `commitStock`, `redeemDiscount`, `getPayments`
- Produces:
  - `formatOrderNumber(n: number): string` → `"CS-1042"`
  - `parseOrderNumber(s: string): number | null`
  - `createPendingOrder(args): Promise<{ order: Order; clientSecret: string }>`
  - `markOrderPaid(paymentIntentId: string, eventId: string): Promise<Order | null>`
  - `findOrderByNumber(orderNumber: number, email: string): Promise<OrderWithItems | null>`
  - `findOrderByNumberForIds(orderNumber: number, allowedOrderIds: string[]): Promise<OrderWithItems | null>`
  - `type OrderWithItems = Order & { items: OrderItem[] }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/orders/orders.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatOrderNumber, parseOrderNumber } from "./format";

describe("order number formatting", () => {
  it("renders with the CS prefix", () => {
    expect(formatOrderNumber(1042)).toBe("CS-1042");
  });

  it("round-trips", () => {
    expect(parseOrderNumber(formatOrderNumber(1042))).toBe(1042);
  });

  it("parses a bare number", () => {
    expect(parseOrderNumber("1042")).toBe(1042);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(parseOrderNumber("  cs-1042 ")).toBe(1042);
  });

  it("rejects nonsense", () => {
    expect(parseOrderNumber("not-an-order")).toBeNull();
    expect(parseOrderNumber("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/orders`
Expected: FAIL — `Failed to resolve import "./format"`

- [ ] **Step 3: Implement order-number formatting**

Create `src/lib/orders/format.ts`:

```ts
export function formatOrderNumber(orderNumber: number): string {
  return `CS-${orderNumber}`;
}

export function parseOrderNumber(input: string): number | null {
  const match = input.trim().toUpperCase().match(/^(?:CS-)?(\d+)$/);
  if (!match) return null;
  return Number(match[1]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/orders`
Expected: PASS — 5 tests passing

- [ ] **Step 5: Implement the orders module**

Create `src/lib/orders/index.ts`:

```ts
import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  orders,
  orderItems,
  stripeEvents,
  type Order,
  type OrderItem,
  type Address,
} from "@/lib/db/schema";
import { quote, type QuoteLine, type AppliedDiscount } from "@/lib/pricing/quote";
import {
  reserveStock,
  releaseStock,
  commitStock,
  RESERVATION_WINDOW_MS,
} from "@/lib/inventory";
import { redeemDiscount } from "@/lib/discounts";
import { getProductsByIds } from "@/lib/catalog";
import { getPayments } from "@/lib/payments";

export * from "./format";

export type OrderWithItems = Order & { items: OrderItem[] };

/**
 * Thrown when a line names a product that cannot be sold — deleted, or no
 * longer active. Reaching checkout with one means the cart outlived the
 * catalogue entry, so the order must not be written at the stale terms.
 */
export class ProductUnavailableError extends Error {
  constructor(public readonly productId: string) {
    super(`Product ${productId} is not available for purchase`);
    this.name = "ProductUnavailableError";
  }
}

/**
 * Thrown when a line's price disagrees with the catalogue. Charging the
 * caller's figure would bill a price the catalogue never offered; charging the
 * catalogue's silently would bill a price the customer was never shown. Both
 * are wrong, so this refuses and lets the caller re-quote.
 */
export class PriceMismatchError extends Error {
  constructor(
    public readonly productId: string,
    public readonly expectedCents: number,
    public readonly receivedCents: number,
  ) {
    super(
      `Product ${productId} is priced ${expectedCents} in the catalogue, not ${receivedCents}`,
    );
    this.name = "PriceMismatchError";
  }
}

/**
 * Treats the caller's prices as a claim rather than as fact.
 *
 * This is what makes createPendingOrder's "never from anything the client
 * sent" guarantee true. It previously held only because every caller happened
 * to build its lines from getCartLines — a convention nothing enforced, and
 * one a price change between cart render and submit breaks on its own.
 */
async function assertLinesMatchCatalog(cartLines: QuoteLine[]): Promise<void> {
  const catalog = await getProductsByIds(cartLines.map((l) => l.productId));
  const byId = new Map(catalog.map((p) => [p.id, p]));

  for (const line of cartLines) {
    const product = byId.get(line.productId);
    if (!product || !product.active) {
      throw new ProductUnavailableError(line.productId);
    }
    if (product.priceCents !== line.unitPriceCents) {
      throw new PriceMismatchError(
        line.productId,
        product.priceCents,
        line.unitPriceCents,
      );
    }
  }
}

/**
 * Creates (or refreshes) a pending order and its PaymentIntent.
 *
 * The amount is computed here from database prices — never from anything the
 * client sent. Inventory is reserved in the same transaction that writes the
 * order, so a successful return means the stock is genuinely held.
 */
export async function createPendingOrder(args: {
  cartLines: QuoteLine[];
  cartId?: string | null;
  email: string;
  /** Set when the buyer is signed in. Guest orders stay null and are claimed
   *  later by @/lib/orders/claim when the address is verified. */
  userId?: string | null;
  shippingAddress: Address;
  billingAddress?: Address | null;
  discount?: AppliedDiscount | null;
  existingOrderId?: string | null;
}): Promise<{ order: Order; clientSecret: string }> {
  const { cartLines, email, shippingAddress, discount = null } = args;

  if (cartLines.length === 0) throw new Error("Cannot create an order from an empty cart");

  // Before the tax call and before any stock is reserved: a rejected order
  // should cost neither a Stripe round trip nor a reservation to reclaim.
  await assertLinesMatchCatalog(cartLines);

  const payments = getPayments();
  const preTax = quote(cartLines, discount, 0);
  const tax = await payments.calculateTax({
    lines: cartLines,
    shippingCents: preTax.shippingCents,
    discountCents: preTax.discountCents,
    address: shippingAddress,
  });
  const final = quote(cartLines, discount, tax.taxCents);

  const money = {
    email,
    userId: args.userId ?? null,
    cartId: args.cartId ?? null,
    discountCodeId: discount?.id ?? null,
    subtotalCents: final.subtotalCents,
    discountCents: final.discountCents,
    shippingCents: final.shippingCents,
    taxCents: final.taxCents,
    totalCents: final.totalCents,
    shippingAddress,
    billingAddress: args.billingAddress ?? shippingAddress,
    reservationExpiresAt: new Date(Date.now() + RESERVATION_WINDOW_MS),
  };

  const lineValues = (orderId: string) =>
    cartLines.map((line) => ({
      orderId,
      productId: line.productId,
      name: line.name,
      unitPriceCents: line.unitPriceCents,
      quantity: line.quantity,
      totalCents: line.unitPriceCents * line.quantity,
    }));

  const reusable = args.existingOrderId
    ? await findReusablePendingOrder(args.existingOrderId)
    : null;

  const order = await db.transaction(async (tx) => {
    if (reusable) {
      // Editing an address must not stack a second reservation on top of the
      // first. Give the old units back, then re-reserve against the new lines.
      await releaseStock(tx, reusable.id);
      await tx.delete(orderItems).where(eq(orderItems.orderId, reusable.id));
      await tx.insert(orderItems).values(lineValues(reusable.id));

      await reserveStock(
        tx,
        cartLines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      );

      const [updated] = await tx
        .update(orders)
        .set({ ...money, inventoryState: "reserved" })
        .where(eq(orders.id, reusable.id))
        .returning();

      return updated;
    }

    const [created] = await tx
      .insert(orders)
      .values({ ...money, status: "pending" })
      .returning();

    await tx.insert(orderItems).values(lineValues(created.id));

    // Throws OutOfStockError and rolls back the order if stock is gone.
    await reserveStock(
      tx,
      cartLines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
    );
    await tx
      .update(orders)
      .set({ inventoryState: "reserved" })
      .where(eq(orders.id, created.id));

    return created;
  });

  let intent;
  try {
    intent = await payments.createOrUpdateIntent({
      paymentIntentId: reusable?.stripePaymentIntentId ?? null,
      amountCents: final.totalCents,
      email,
      orderId: order.id,
      orderNumber: order.orderNumber,
    });
  } catch (err) {
    // The reservation transaction has already committed. Leaving it alone
    // holds stock against a payment that will never arrive until the expiry
    // sweep reclaims it — up to RESERVATION_WINDOW_MS of a small catalogue
    // made unsellable by an error we already know happened.
    try {
      await cancelReservedOrder(order.id);
    } catch (cleanupErr) {
      // The sweep is still the backstop, so a failed cleanup is recoverable.
      // What is not recoverable is hiding the error the caller needs to see,
      // so this is logged and swallowed rather than thrown.
      console.error("[orders] could not release a failed order's reservation", {
        orderId: order.id,
        cause: cleanupErr,
      });
    }
    throw err;
  }

  // Return the row as it stands AFTER the payment intent id is written.
  // Returning the pre-update `order` would hand the caller a row whose
  // stripePaymentIntentId is always null while the stored row has it set.
  const [withIntent] = await db
    .update(orders)
    .set({ stripePaymentIntentId: intent.paymentIntentId })
    .where(eq(orders.id, order.id))
    .returning();

  return { order: withIntent, clientSecret: intent.clientSecret };
}

/**
 * Undoes a committed reservation whose order can no longer proceed.
 *
 * Deliberately the same end state the expiry sweep produces — cancelled, with
 * the stock given back — so an order cleaned up here is indistinguishable from
 * one the sweep reclaimed, and nothing downstream needs a second case.
 */
async function cancelReservedOrder(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await releaseStock(tx, orderId);
    await tx
      .update(orders)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending")));
  });
}

/**
 * An order may only be reused while it is still pending with a live
 * reservation. Anything paid, failed, or already swept must start fresh —
 * reusing a paid order would let a second charge overwrite a real sale.
 */
async function findReusablePendingOrder(orderId: string): Promise<Order | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.status, "pending"),
        eq(orders.inventoryState, "reserved"),
      ),
    )
    .limit(1);

  return order ?? null;
}

/**
 * Thrown by `markOrderPaid` when a payment intent that Stripe says succeeded
 * has no matching order at all. This should be impossible in normal
 * operation, so we cannot silently swallow it: throwing rolls back the
 * `stripe_events` insert in the same transaction, which makes Stripe retry
 * the webhook and, if retries are exhausted, surfaces the event as failed in
 * the Stripe dashboard for manual reconciliation. A silent 200 here would
 * lose track of real money with no record anywhere.
 */
export class OrderNotFoundForPaymentError extends Error {
  constructor(public readonly paymentIntentId: string) {
    super(`No order found for payment intent ${paymentIntentId}`);
    this.name = "OrderNotFoundForPaymentError";
  }
}

/**
 * Thrown by `markOrderPaid` when the order matching a succeeded payment
 * intent exists but is not `pending` (e.g. it was cancelled by reservation
 * expiry while Stripe was completing a slow payment) and is not already
 * `paid` (which is the normal idempotent replay and returns `null` instead).
 * Throwing — rather than returning `null` — rolls back the `stripe_events`
 * insert in the same transaction, so Stripe retries the webhook instead of
 * treating a stranded charge as handled. That keeps the charge recoverable:
 * retries eventually surface it in the Stripe dashboard rather than letting
 * it vanish with no order, no email, and nothing to reconcile against.
 */
export class StrandedPaymentError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly paymentIntentId: string,
    public readonly status: string,
  ) {
    super(
      `Order ${orderId} for payment intent ${paymentIntentId} is in state "${status}", not pending`,
    );
    this.name = "StrandedPaymentError";
  }
}

/**
 * The only path that sets status 'paid'. Idempotent via the stripe_events
 * ledger — a replayed webhook returns null and changes nothing.
 */
export async function markOrderPaid(
  paymentIntentId: string,
  eventId: string,
): Promise<Order | null> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: eventId, type: "payment_intent.succeeded" })
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

    // "fulfilled" is downstream of "paid": the order was paid and has since
    // shipped. A late or replayed succeeded-event for it is still a no-op, not
    // a stranded payment. Nothing sets "fulfilled" until the admin plan ships,
    // but treating it as stranded then would throw and retry forever.
    if (existing.status === "paid" || existing.status === "fulfilled") {
      // Another event already did the work — idempotent no-op.
      return null;
    }

    if (existing.status !== "pending") {
      throw new StrandedPaymentError(existing.id, paymentIntentId, existing.status);
    }

    const [order] = await tx
      .update(orders)
      .set({ status: "paid", paidAt: new Date() })
      .where(
        and(
          eq(orders.stripePaymentIntentId, paymentIntentId),
          eq(orders.status, "pending"),
        ),
      )
      .returning();

    if (!order) return null;

    await commitStock(tx, order.id);

    if (order.discountCodeId) {
      const recorded = await redeemDiscount(tx, order.discountCodeId);
      if (!recorded) {
        // The cap was exhausted by a concurrent order between checkout and
        // payment. The customer has already been charged the discounted
        // total, so we honour it and record the discrepancy rather than
        // throwing — a throw here would fail the webhook and have Stripe
        // retry a payment that already succeeded.
        //
        // Written to the order, not just logged: a log line cannot be queried,
        // does not survive a restart, and cannot answer how often this happened
        // or on which orders. The warn stays for operational visibility.
        console.warn("[orders] discount applied but not recorded", {
          orderId: order.id,
          discountCodeId: order.discountCodeId,
        });

        const [marked] = await tx
          .update(orders)
          .set({ discountOverrunAt: new Date() })
          .where(eq(orders.id, order.id))
          .returning();

        return marked;
      }
    }

    return order;
  });
}

/**
 * Looks up an order the caller has already proved access to, by matching the
 * order number against a set of order ids granted to this browser.
 *
 * The id filter is part of the WHERE clause rather than a check on the result,
 * so there is no code path here that reads an order without a credential.
 * An empty grant list short-circuits: `inArray(x, [])` is an SQL no-op in some
 * dialects, and "no credentials" must never mean "no filter".
 */
export async function findOrderByNumberForIds(
  orderNumber: number,
  allowedOrderIds: string[],
): Promise<OrderWithItems | null> {
  if (allowedOrderIds.length === 0) return null;

  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.orderNumber, orderNumber),
        inArray(orders.id, allowedOrderIds),
      ),
    )
    .limit(1);

  if (!order) return null;

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  return { ...order, items };
}

export async function findOrderByNumber(
  orderNumber: number,
  email: string,
): Promise<OrderWithItems | null> {
  const [order] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.orderNumber, orderNumber),
        sql`LOWER(${orders.email}) = LOWER(${email})`,
      ),
    )
    .limit(1);

  if (!order) return null;

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  return { ...order, items };
}

export async function findOrderById(id: string): Promise<OrderWithItems | null> {
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) return null;

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  return { ...order, items };
}
```

- [ ] **Step 6: Write the pending-order reuse test**

Create `src/lib/orders/reuse.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { products, inventory, orders } from "@/lib/db/schema";
import { FakePayments } from "@/lib/payments/fake";

const fake = new FakePayments();
vi.mock("@/lib/payments", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments")>(
    "@/lib/payments",
  );
  return { ...actual, getPayments: () => fake };
});

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { createPendingOrder } = await import("./index");

let productId: string;
const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US" as const,
};

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  // FakePayments is a module-scope singleton (vi.mock above captures one
  // instance for the whole file), so its in-memory state must be reset here
  // just like the database is truncated — otherwise `fake.intents.size`
  // accumulates across tests instead of reflecting the current test alone.
  fake.intents.clear();
  fake.refunds.length = 0;
  const [product] = await ctx.db
    .insert(products)
    .values({
      slug: "edt",
      name: "Coldsmoke Eau de Toilette",
      description: "d",
      priceCents: 4500,
      sku: "CS-1",
    })
    .returning();
  productId = product.id;
  await ctx.db.insert(inventory).values({ productId, onHand: 5, reserved: 0 });
});

function lines(quantity = 1) {
  return [
    {
      productId,
      name: "Coldsmoke Eau de Toilette",
      unitPriceCents: 4500,
      quantity,
    },
  ];
}

async function reserved() {
  const [row] = await ctx.db
    .select()
    .from(inventory)
    .where(eq(inventory.productId, productId));
  return row.reserved;
}

describe("createPendingOrder reuse", () => {
  it("reserves stock once for a first submission", async () => {
    await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
    });
    expect(await reserved()).toBe(1);
  });

  it("does not stack reservations when an address is corrected", async () => {
    const first = await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
    });

    await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: { ...ADDRESS, line1: "2 Powder Lane" },
      existingOrderId: first.order.id,
    });

    expect(await reserved()).toBe(1);

    const rows = await ctx.db.select().from(orders);
    expect(rows).toHaveLength(1);
    expect((rows[0].shippingAddress as typeof ADDRESS).line1).toBe("2 Powder Lane");
  });

  it("adjusts the reservation when the quantity changes", async () => {
    const first = await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
    });

    await createPendingOrder({
      cartLines: lines(3),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
      existingOrderId: first.order.id,
    });

    expect(await reserved()).toBe(3);
  });

  it("reuses the same PaymentIntent rather than creating a second", async () => {
    const first = await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
    });

    const second = await createPendingOrder({
      cartLines: lines(2),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
      existingOrderId: first.order.id,
    });

    expect(second.order.id).toBe(first.order.id);
    expect(fake.intents.size).toBe(1);
  });

  it("starts a fresh order when the existing one is already paid", async () => {
    const first = await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
    });

    await ctx.db
      .update(orders)
      .set({ status: "paid", inventoryState: "committed" })
      .where(eq(orders.id, first.order.id));

    const second = await createPendingOrder({
      cartLines: lines(1),
      email: "buyer@example.com",
      shippingAddress: ADDRESS,
      existingOrderId: first.order.id,
    });

    expect(second.order.id).not.toBe(first.order.id);
    const rows = await ctx.db.select().from(orders);
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- src/lib/orders`
Expected: PASS — 5 formatting tests plus 5 reuse tests.

- [ ] **Step 8: Verify it type-checks and commit**

```bash
npx tsc --noEmit
git add src/lib/orders
git commit -m "feat: order creation, pending-order reuse, and idempotent paid transition"
```

---

## Task 10: Transactional email

**Files:**
- Create: `src/lib/email/client.ts`, `src/lib/email/OrderConfirmation.tsx`, `src/lib/email/index.tsx`

**Interfaces:**
- Consumes: `OrderWithItems` from `@/lib/orders`, `formatCents` from `@/lib/money`
- Produces: `sendOrderConfirmation(order: OrderWithItems): Promise<void>`

- [ ] **Step 1: Create the Resend client**

Create `src/lib/email/client.ts`:

```ts
import { Resend } from "resend";

let client: Resend | null = null;

export function getResend(): Resend {
  if (!client) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not set");
    client = new Resend(key);
  }
  return client;
}

export const EMAIL_FROM =
  process.env.EMAIL_FROM ?? "Coldsmoke <orders@wearcoldsmoke.com>";
```

- [ ] **Step 2: Build the confirmation template**

Create `src/lib/email/OrderConfirmation.tsx`:

```tsx
import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Hr,
  Row,
  Column,
} from "@react-email/components";
import { formatCents } from "@/lib/money";
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

export function OrderConfirmation({ order }: { order: OrderWithItems }) {
  const address = order.shippingAddress;

  return (
    <Html>
      <Head />
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.wordmark}>COLDSMOKE</Text>
          <Hr style={styles.hr} />

          <Text style={styles.text}>
            Your order is confirmed. {formatOrderNumber(order.orderNumber)}.
          </Text>
          <Text style={styles.text}>
            We&apos;ll email you again when it ships.
          </Text>

          <Hr style={styles.hr} />
          <Text style={styles.label}>Order</Text>

          {order.items.map((item) => (
            <Row key={item.id}>
              <Column>
                <Text style={styles.text}>
                  {item.name} × {item.quantity}
                </Text>
              </Column>
              <Column align="right">
                <Text style={styles.bright}>{formatCents(item.totalCents)}</Text>
              </Column>
            </Row>
          ))}

          <Hr style={styles.hr} />

          <SummaryRow label="Subtotal" value={formatCents(order.subtotalCents)} />
          {order.discountCents > 0 && (
            <SummaryRow label="Discount" value={`-${formatCents(order.discountCents)}`} />
          )}
          <SummaryRow
            label="Shipping"
            value={order.shippingCents === 0 ? "Free" : formatCents(order.shippingCents)}
          />
          <SummaryRow label="Tax" value={formatCents(order.taxCents)} />
          <SummaryRow label="Total" value={formatCents(order.totalCents)} />

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

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <Column>
        <Text style={styles.text}>{label}</Text>
      </Column>
      <Column align="right">
        <Text style={styles.bright}>{value}</Text>
      </Column>
    </Row>
  );
}
```

- [ ] **Step 3: Implement the send function**

**.tsx, not .ts** — resend's types for the `react` field expect a
`ReactElement`, so this file contains JSX.

Create `src/lib/email/index.tsx`:

```ts
import { getResend, EMAIL_FROM } from "./client";
import { OrderConfirmation } from "./OrderConfirmation";
import { formatOrderNumber } from "@/lib/orders/format";
import type { OrderWithItems } from "@/lib/orders";

/**
 * Never throws. The payment already succeeded by the time this runs — a failed
 * email must not fail the webhook and trigger a Stripe retry.
 */
export async function sendOrderConfirmation(
  order: OrderWithItems,
): Promise<void> {
  try {
    await getResend().emails.send({
      from: EMAIL_FROM,
      to: order.email,
      subject: `Coldsmoke order ${formatOrderNumber(order.orderNumber)}`,
      react: <OrderConfirmation order={order} />,
    });
  } catch (error) {
    console.error("[email] order confirmation failed", {
      orderId: order.id,
      error,
    });
  }
}
```

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit
git add src/lib/email
git commit -m "feat: order confirmation email"
```

---

## Task 11: UI primitives and the site shell

**Files:**
- Create: `src/components/ui/Wordmark.tsx`, `src/components/ui/Button.tsx` + `.module.css`, `src/components/ui/Field.tsx` + `.module.css`, `src/components/ui/Price.tsx`, `src/components/SiteHeader.tsx` + `.module.css`, `src/components/SiteFooter.tsx` + `.module.css`, `src/app/(store)/layout.tsx`

**Interfaces:**
- Consumes: tokens from `src/styles/tokens.css`, `formatCents` from `@/lib/money`
- Produces: `<Wordmark size>`, `<Button variant intent>`, `<Field label error>`, `<Price cents>`, `<SiteHeader cartCount>`, `<SiteFooter>`

- [ ] **Step 1: Build the wordmark**

Create `src/components/ui/Wordmark.tsx`:

```tsx
export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    // No aria-label: it would duplicate the element's own text, and in
    // SiteHeader the wrapping link's label overrides it anyway.
    <span
      style={{
        fontSize: size,
        fontWeight: 300,
        letterSpacing: "var(--track-wide)",
        background:
          "linear-gradient(90deg, var(--silver-start), var(--silver-mid), var(--silver-end))",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        whiteSpace: "nowrap",
      }}
    >
      COLDSMOKE
    </span>
  );
}
```

- [ ] **Step 2: Build the button**

Create `src/components/ui/Button.module.css`:

```css
.base {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0.9rem 1.8rem;
  border: 1px solid var(--line-bright);
  background: transparent;
  color: var(--text-bright);
  font-size: 0.78rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
}

.base:hover:not(:disabled) {
  border-color: var(--silver-mid);
  color: var(--silver-mid);
}

.base:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.primary {
  background: var(--silver-mid);
  border-color: var(--silver-mid);
  color: var(--ground);
}

.primary:hover:not(:disabled) {
  background: #fff;
  border-color: #fff;
  color: var(--ground);
}

.quiet {
  border-color: transparent;
  padding: 0.4rem 0;
  color: var(--text-dim);
}

.quiet:hover:not(:disabled) {
  color: var(--text-bright);
}

.block {
  width: 100%;
}
```

Create `src/components/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";
import Link, { type LinkProps } from "next/link";
import styles from "./Button.module.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "quiet";
  block?: boolean;
};

function buttonClasses(
  variant: "primary" | "outline" | "quiet",
  block: boolean,
  className?: string,
) {
  return [
    styles.base,
    variant === "primary" && styles.primary,
    variant === "quiet" && styles.quiet,
    block && styles.block,
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "outline",
  block = false,
  className,
  ...rest
}: Props) {
  return <button className={buttonClasses(variant, block, className)} {...rest} />;
}

/**
 * A link that looks like a button.
 *
 * Use this instead of wrapping <Button> in <Link>. Nesting a <button> inside
 * an <a> is invalid HTML: it gives keyboard users two tab stops for one
 * control and leaves screen readers to guess which element to announce.
 */
export function ButtonLink({
  href,
  variant = "outline",
  block = false,
  className,
  children,
  ...rest
}: Omit<LinkProps, "className"> & {
  variant?: "primary" | "outline" | "quiet";
  block?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClasses(variant, block, className)} {...rest}>
      {children}
    </Link>
  );
}
```

- [ ] **Step 3: Build the form field**

Create `src/components/ui/Field.module.css`:

```css
.wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.label {
  font-size: 0.68rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
}

.input {
  width: 100%;
  padding: 0.8rem 0.9rem;
  background: var(--panel);
  /* --line is 1.70:1 on panel — below the 3:1 WCAG needs for control borders. */
  border: 1px solid var(--line-bright);
  color: var(--text-bright);
  border-radius: 2px;
}

.input:focus {
  border-color: var(--silver-start);
}

.invalid {
  border-color: var(--danger);
}

.error {
  font-size: 0.8rem;
  color: var(--danger);
}
```

Create `src/components/ui/Field.tsx`:

```tsx
"use client";

import { useId, type InputHTMLAttributes } from "react";
import styles from "./Field.module.css";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
};

export function Field({ label, error, className, ...rest }: Props) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className={styles.wrap}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={[styles.input, error && styles.invalid, className]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
      {error && (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Build the price component**

Create `src/components/ui/Price.tsx`:

```tsx
import { formatCents } from "@/lib/money";

export function Price({ cents }: { cents: number }) {
  return <span>{formatCents(cents)}</span>;
}
```

- [ ] **Step 5: Build the header**

Create `src/components/SiteHeader.module.css`:

```css
.header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--ground) 88%, transparent);
  backdrop-filter: blur(8px);
}

.nav {
  display: flex;
  gap: var(--space-4);
  font-size: 0.7rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
}

.nav a:hover {
  color: var(--text-bright);
}

.cart {
  font-size: 0.7rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-bright);
}
```

Create `src/components/SiteHeader.tsx`:

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

- [ ] **Step 6: Build the footer**

Create `src/components/SiteFooter.module.css`:

```css
.footer {
  margin-top: auto;
  padding: var(--space-6) var(--space-4) var(--space-5);
  border-top: 1px solid var(--line);
  color: var(--text-faint);
  font-size: 0.78rem;
}

.inner {
  max-width: var(--page-max);
  margin: 0 auto;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
  justify-content: space-between;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.links a:hover {
  color: var(--text);
}
```

Create `src/components/SiteFooter.tsx`:

```tsx
import Link from "next/link";
import styles from "./SiteFooter.module.css";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <p>Cold air. Dark spice.</p>
        <nav className={styles.links} aria-label="Footer">
          <Link href="/faq">FAQ</Link>
          <Link href="/shipping-returns">Shipping &amp; Returns</Link>
          <Link href="/order-lookup">Find an order</Link>
          <Link href="/contact">Contact</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
        <p>© {new Date().getFullYear()} Coldsmoke</p>
      </div>
    </footer>
  );
}
```

- [ ] **Step 7: Create the store layout**

Create `src/app/(store)/layout.tsx`:

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

- [ ] **Step 8: Verify and commit**

```bash
npx tsc --noEmit
git add src/components src/app/\(store\)
git commit -m "feat: UI primitives and site shell"
```

---

## Task 12: Home, shop, and product pages

**Files:**
- Delete: `src/app/page.tsx`, `src/app/page.module.css`
- Create: `src/app/(store)/page.tsx` + `.module.css`, `src/app/(store)/shop/page.tsx` + `.module.css`, `src/app/(store)/product/[slug]/page.tsx` + `.module.css`, `src/app/(store)/actions.ts`

**Interfaces:**
- Consumes: `getActiveProducts`, `getProductBySlug`, `getOrCreateCartId`, `addItem`
- Produces: Server Action `addToCartAction(formData: FormData): Promise<void>`

- [ ] **Step 1: Remove the scaffold home page**

```bash
git rm src/app/page.tsx src/app/page.module.css
```

- [ ] **Step 2: Create the add-to-cart Server Action**

<!-- plan-drift: partial — Task 13 appends the discount action to this file, so this block is the intermediate state, not the final file. -->
Create `src/app/(store)/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  getOrCreateCartId,
  addItem,
  setQuantity,
  MAX_LINE_QUANTITY,
} from "@/lib/cart";

/**
 * Form values are strings and can be anything a client chooses to send. An
 * empty input yields Number("") === 0, and addItem/setQuantity throw on values
 * that are not integers in range — which would escape a Server Action as an
 * unhandled error. Coerce here and let the caller decide the fallback.
 */
function parseQuantity(raw: FormDataEntryValue | null, min: number): number | null {
  if (typeof raw !== "string") return null;

  // Number("") and Number("  ") are both 0. Without this guard a blank box
  // would parse as an explicit zero, which on the cart page means "remove this
  // line" — a cleared field must not silently delete anything.
  if (raw.trim() === "") return null;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < min || parsed > MAX_LINE_QUANTITY) return null;
  return parsed;
}

export async function addToCartAction(formData: FormData): Promise<void> {
  const productId = String(formData.get("productId") ?? "");
  // A missing or malformed quantity means "one of these, please".
  const quantity = parseQuantity(formData.get("quantity"), 1) ?? 1;

  if (!productId) throw new Error("Missing productId");

  const cartId = await getOrCreateCartId();
  await addItem(cartId, productId, quantity);

  revalidatePath("/cart");
  redirect("/cart");
}

export async function setQuantityAction(formData: FormData): Promise<void> {
  const productId = String(formData.get("productId") ?? "");
  // 0 is meaningful here — it removes the line.
  const quantity = parseQuantity(formData.get("quantity"), 0);

  // Garbage in the box shouldn't silently delete the line; re-render instead,
  // which restores the stored quantity.
  if (quantity === null) {
    revalidatePath("/cart");
    return;
  }

  const cartId = await getOrCreateCartId();
  await setQuantity(cartId, productId, quantity);

  revalidatePath("/cart");
}
```

- [ ] **Step 3: Build the home page**

Create `src/app/(store)/page.module.css`:

```css
.hero {
  min-height: 78vh;
  display: grid;
  place-items: center;
  text-align: center;
  padding: var(--space-7) var(--space-4);
  background:
    radial-gradient(ellipse at 50% 0%, #1b1b21 0%, transparent 62%),
    var(--ground);
}

.tagline {
  margin-top: var(--space-4);
  font-size: clamp(1.6rem, 5vw, 2.6rem);
  font-weight: 200;
  letter-spacing: var(--track-tight);
  color: var(--text-bright);
}

.sub {
  margin: var(--space-4) auto 0;
  max-width: 46ch;
  color: var(--text-dim);
}

.cta {
  margin-top: var(--space-5);
  display: flex;
  gap: var(--space-3);
  justify-content: center;
  flex-wrap: wrap;
}

.notes {
  max-width: var(--page-max);
  margin: 0 auto;
  padding: var(--space-7) var(--space-4);
  display: grid;
  gap: var(--space-5);
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.note h2 {
  font-size: 0.68rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
  font-weight: 400;
  margin-bottom: var(--space-3);
}

.note p {
  color: var(--text-bright);
  font-weight: 200;
  font-size: 1.05rem;
  line-height: 1.7;
}
```

Create `src/app/(store)/page.tsx`:

```tsx
import { Wordmark } from "@/components/ui/Wordmark";
import { ButtonLink } from "@/components/ui/Button";
import styles from "./page.module.css";

const NOTES = [
  { layer: "Top", body: "Bergamot, iced spearmint, black and pink pepper." },
  { layer: "Heart", body: "Cardamom, clary sage, a whisper of cinnamon, lavender." },
  { layer: "Base", body: "Dark musk, amber, cedarwood, patchouli, smoky vetiver." },
];

export default function HomePage() {
  return (
    <>
      <section className={styles.hero}>
        <div>
          <Wordmark size={40} />
          <h1 className={styles.tagline}>Cold air. Dark spice.</h1>
          <p className={styles.sub}>
            A crisp icy opening that burns down into spice, musk, and a wisp of
            smoke. Cold up top. Smoke underneath.
          </p>
          <div className={styles.cta}>
            <ButtonLink href="/shop" variant="primary">
              Shop
            </ButtonLink>
            <ButtonLink href="/the-scent">The scent</ButtonLink>
          </div>
        </div>
      </section>

      <section className={styles.notes} aria-label="Scent notes">
        {NOTES.map((note) => (
          <div key={note.layer} className={styles.note}>
            <h2>{note.layer}</h2>
            <p>{note.body}</p>
          </div>
        ))}
      </section>
    </>
  );
}
```

- [ ] **Step 4: Build the shop page**

Create `src/app/(store)/shop/page.module.css`:

```css
.page {
  max-width: var(--page-max);
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.heading {
  font-size: 0.7rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
  font-weight: 400;
  margin-bottom: var(--space-5);
}

.grid {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.card {
  display: block;
  padding: var(--space-5) var(--space-4);
  background: var(--panel);
  border: 1px solid var(--line);
  transition: border-color 160ms ease;
}

/* No border of its own: the card already has one, and nesting a second inside
   it reads as a box in a box. The gradient alone separates art from panel. */
.thumb {
  position: relative;
  aspect-ratio: 1 / 1;
  margin-bottom: var(--space-4);
  overflow: hidden;
  background: linear-gradient(180deg, #17171b, #0a0a0c);
  display: grid;
  place-items: center;
}

.thumbImage {
  object-fit: contain;
}

.card:hover {
  border-color: var(--line-bright);
}

.name {
  color: var(--text-bright);
  font-size: 1.1rem;
  font-weight: 300;
  letter-spacing: var(--track-tight);
}

.tagline {
  color: var(--text-dim);
  font-size: 0.9rem;
  margin-top: var(--space-2);
}

.meta {
  margin-top: var(--space-4);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  color: var(--text-bright);
}

.soldOut {
  color: var(--text-faint);
  font-size: 0.75rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
}
```

Create `src/app/(store)/shop/page.tsx`:

```tsx
import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { getActiveProducts } from "@/lib/catalog";
import { Wordmark } from "@/components/ui/Wordmark";
import { Price } from "@/components/ui/Price";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Shop" };

export default async function ShopPage() {
  const products = await getActiveProducts();

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Shop</h1>

      <div className={styles.grid}>
        {products.map((product) => (
          <Link
            key={product.id}
            href={`/product/${product.slug}`}
            className={styles.card}
          >
            <div className={styles.thumb}>
              {product.images[0] ? (
                <Image
                  src={product.images[0].url}
                  // Empty: the card's own name and tagline already say what
                  // this is, and the link reads them out. A description here
                  // would just repeat them.
                  alt=""
                  fill
                  className={styles.thumbImage}
                  sizes="(max-width: 640px) 100vw, 320px"
                />
              ) : (
                <Wordmark size={18} />
              )}
            </div>

            <div className={styles.name}>{product.name}</div>
            {product.tagline && (
              <div className={styles.tagline}>{product.tagline}</div>
            )}
            <div className={styles.meta}>
              <Price cents={product.priceCents} />
              {product.available <= 0 && (
                <span className={styles.soldOut}>Sold out</span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Build the product detail page**

Create `src/app/(store)/product/[slug]/page.module.css`:

```css
.page {
  max-width: var(--page-max);
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
  display: grid;
  gap: var(--space-6);
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}

/* Square, because the product imagery is square. A 3/4 box either crops the
   art or letterboxes it, and the brand card cannot survive a crop. */
.visual {
  position: relative;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background: linear-gradient(180deg, #17171b, #0a0a0c);
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
}

.image {
  /* contain, not cover: the brand card carries an inset border frame and type
     that runs nearly the full width, and cover shaves both off the edges. */
  object-fit: contain;
}

.name {
  font-size: clamp(1.5rem, 3vw, 2rem);
  font-weight: 200;
  color: var(--text-bright);
  letter-spacing: var(--track-tight);
}

.tagline {
  color: var(--text-dim);
  margin-top: var(--space-2);
  font-style: italic;
}

.price {
  margin-top: var(--space-4);
  font-size: 1.25rem;
  color: var(--text-bright);
}

.description {
  margin-top: var(--space-4);
  max-width: var(--measure);
}

.form {
  margin-top: var(--space-5);
  display: flex;
  gap: var(--space-3);
  align-items: center;
  flex-wrap: wrap;
}

.qty {
  width: 5rem;
  padding: 0.85rem 0.9rem;
  background: var(--panel);
  /* --line-bright, not --line: this is a control border and must clear 3:1. */
  border: 1px solid var(--line-bright);
  color: var(--text-bright);
}

.stock {
  margin-top: var(--space-3);
  font-size: 0.8rem;
  color: var(--text-faint);
}

.legal {
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: 1px solid var(--line);
  font-size: 0.78rem;
  color: var(--text-faint);
  max-width: var(--measure);
}
```

Create `src/app/(store)/product/[slug]/page.tsx`:

```tsx
import Image from "next/image";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProductBySlug } from "@/lib/catalog";
import { MAX_LINE_QUANTITY } from "@/lib/cart";
import { Wordmark } from "@/components/ui/Wordmark";
import { Button } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { addToCartAction } from "../../actions";
import styles from "./page.module.css";

export async function generateMetadata({
  params,
}: PageProps<"/product/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  return { title: product?.name ?? "Not found" };
}

export default async function ProductPage({
  params,
}: PageProps<"/product/[slug]">) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const soldOut = product.available <= 0;
  const image = product.images[0];

  return (
    <div className={styles.page}>
      <div className={styles.visual}>
        {image ? (
          <Image
            src={image.url}
            alt={image.alt}
            // fill, not width/height: the URL comes from the database, so the
            // intrinsic size is not known at build time.
            fill
            className={styles.image}
            sizes="(max-width: 640px) 100vw, 45vw"
            priority
          />
        ) : (
          <Wordmark size={24} />
        )}
      </div>

      <div>
        <h1 className={styles.name}>{product.name}</h1>
        {product.tagline && <p className={styles.tagline}>{product.tagline}</p>}
        <p className={styles.price}>
          <Price cents={product.priceCents} />
        </p>
        <p className={styles.description}>{product.description}</p>

        <form action={addToCartAction} className={styles.form}>
          <input type="hidden" name="productId" value={product.id} />
          <label className="sr-only" htmlFor="quantity">
            Quantity
          </label>
          <input
            id="quantity"
            className={styles.qty}
            type="number"
            name="quantity"
            defaultValue={1}
            min={1}
            max={Math.min(Math.max(product.available, 1), MAX_LINE_QUANTITY)}
            disabled={soldOut}
          />
          <Button type="submit" variant="primary" disabled={soldOut}>
            {soldOut ? "Sold out" : "Add to cart"}
          </Button>
        </form>

        {!soldOut && product.available <= 10 && (
          <p className={styles.stock}>{product.available} left.</p>
        )}

        <p className={styles.legal}>
          Eau de Toilette Spray. Ships ground within the US only — fragrance
          cannot travel by air. For external use only.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Add the screen-reader utility class**

Append to `src/app/globals.css`:

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 7: Run the app and verify**

```bash
npm run dev
```

Visit `http://localhost:3000` — the hero renders on near-black. Visit `/shop` — both seeded products appear with prices. Click the bottle, add to cart, and confirm the redirect to `/cart` (which 404s until Task 13).

- [ ] **Step 8: Commit**

```bash
git add -A src/app src/components
git commit -m "feat: home, shop, and product pages"
```

---

## Task 13: Cart page

**Files:**
- Create: `src/app/(store)/cart/page.tsx` + `.module.css`, `src/app/(store)/cart/DiscountForm.tsx`, `src/app/(store)/cart/QuantityStepper.tsx`
- Modify: `src/app/(store)/actions.ts`

**Interfaces:**
- Consumes: `getCartLines`, `quote`, `lookupDiscount`, `validateDiscount`, `discountFailureMessage`
- Produces: `applyDiscountAction(prev, formData): Promise<DiscountFormState>`; discount code persisted in the `cs_discount` cookie

- [ ] **Step 1: Add the discount Server Action**

`DISCOUNT_COOKIE` already exists in `src/lib/cookies.ts`, created in Task 7 —
a `"use server"` file may export only async functions, so cookie names cannot
live beside the actions that read them.

Append to `src/app/(store)/actions.ts`:

```ts
// Add to the existing imports at the top of the file:
import { cookies } from "next/headers";
import { getCartId, getCartLines } from "@/lib/cart";
import { quote } from "@/lib/pricing/quote";
import { DISCOUNT_COOKIE } from "@/lib/cookies";
import {
  lookupDiscount,
  validateDiscount,
  discountFailureMessage,
} from "@/lib/discounts";

export type DiscountFormState = { error?: string; applied?: string };

export async function applyDiscountAction(
  _prev: DiscountFormState,
  formData: FormData,
): Promise<DiscountFormState> {
  const raw = String(formData.get("code") ?? "");
  const jar = await cookies();

  // An empty submission clears whatever code was applied.
  if (!raw.trim()) {
    jar.delete(DISCOUNT_COOKIE);
    revalidatePath("/cart");
    return {};
  }

  const cartId = await getOrCreateCartId();
  const lines = await getCartLines(cartId);
  const { subtotalCents } = quote(lines);

  const code = await lookupDiscount(raw);
  const result = validateDiscount(code, subtotalCents);

  if (!result.ok) {
    // Rejecting a new code also drops any previously applied one, so the page
    // has to re-render or the totals keep showing a discount that is now gone.
    jar.delete(DISCOUNT_COOKIE);
    revalidatePath("/cart");
    return { error: discountFailureMessage(result.reason, code ?? undefined) };
  }

  jar.set(DISCOUNT_COOKIE, result.discount.code, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });

  revalidatePath("/cart");
  return { applied: result.discount.code };
}

/**
 * Shared by the cart and checkout pages so both price identically. Read-only
 * on purpose — it runs during Server Component render, where setting a cookie
 * would throw.
 *
 * Re-validates against the current subtotal on every call, so a code that
 * needed a $50 order stops applying by itself once the cart drops below it.
 */
export async function getActiveDiscount() {
  const jar = await cookies();
  const stored = jar.get(DISCOUNT_COOKIE)?.value;
  if (!stored) return null;

  const cartId = await getCartId();
  if (!cartId) return null;
  const lines = await getCartLines(cartId);
  const { subtotalCents } = quote(lines);

  const code = await lookupDiscount(stored);
  const result = validateDiscount(code, subtotalCents);
  return result.ok ? result.discount : null;
}
```

- [ ] **Step 2: Build the discount form client component**

Create `src/app/(store)/cart/DiscountForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { applyDiscountAction, type DiscountFormState } from "../actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./page.module.css";

export function DiscountForm({ applied }: { applied: string | null }) {
  const [state, action, pending] = useActionState<DiscountFormState, FormData>(
    applyDiscountAction,
    { applied: applied ?? undefined },
  );

  return (
    <form action={action} className={styles.discountForm}>
      <Field
        label="Discount code"
        name="code"
        defaultValue={state.applied ?? ""}
        error={state.error}
        autoComplete="off"
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Checking" : "Apply"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 3: Build the cart page**

Create `src/app/(store)/cart/page.module.css`:

```css
.page {
  max-width: 900px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.heading {
  font-size: 0.7rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
  font-weight: 400;
  margin-bottom: var(--space-5);
}

.line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--line);
}

.lineName {
  color: var(--text-bright);
}

.lineUnit {
  color: var(--text-dim);
  font-size: 0.85rem;
}

.qtyForm {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.stepper {
  display: flex;
  align-items: center;
  /* --line-bright, not --line: this is a control border and must clear 3:1. */
  border: 1px solid var(--line-bright);
}

.stepButton {
  width: 2.25rem;
  height: 2.25rem;
  display: grid;
  place-items: center;
  background: var(--panel);
  color: var(--text-bright);
  border: 0;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.stepButton:hover:not(:disabled) {
  background: var(--panel-raised);
}

.stepButton:disabled {
  color: var(--text-faint);
  cursor: default;
}

.count {
  min-width: 2.5rem;
  text-align: center;
  color: var(--text-bright);
  font-variant-numeric: tabular-nums;
}

/* Dim the row while the server catches up, without moving anything. */
.pending {
  opacity: 0.6;
}

.remove {
  background: none;
  border: 0;
  padding: 0;
  margin-left: var(--space-3);
  color: var(--text-dim);
  font-size: 0.78rem;
  text-decoration: underline;
  cursor: pointer;
}

.remove:hover {
  color: var(--text-bright);
}

.summary {
  margin-top: var(--space-5);
  display: grid;
  gap: var(--space-5);
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.discountForm {
  display: grid;
  gap: var(--space-3);
  align-content: start;
}

.totals {
  display: grid;
  gap: var(--space-2);
}

.row {
  display: flex;
  justify-content: space-between;
}

.total {
  border-top: 1px solid var(--line);
  padding-top: var(--space-3);
  margin-top: var(--space-2);
  color: var(--text-bright);
  font-size: 1.05rem;
}

.note {
  font-size: 0.78rem;
  color: var(--text-faint);
  margin-top: var(--space-2);
}

.empty {
  color: var(--text-dim);
}

.emptyCta {
  margin-top: var(--space-5);
}

.checkoutCta {
  margin-top: var(--space-3);
}
```

Create `src/app/(store)/cart/QuantityStepper.tsx`:

```tsx
"use client";

import { useFormStatus } from "react-dom";
import { MAX_LINE_QUANTITY } from "@/lib/cart/limits";
import { setQuantityAction } from "../actions";
import styles from "./page.module.css";

/**
 * Per-line quantity control.
 *
 * Every control is a submit button carrying the quantity it would produce, so
 * the form still works with JavaScript disabled — the rest of the store is
 * built on Server Components and form actions, and this should not be the one
 * control that silently does nothing without JS.
 *
 * `setQuantityAction` is passed to `action` DIRECTLY rather than wrapped in a
 * client function. Next only emits the native form POST (method, URL, hidden
 * action id) when it can see a Server Action here; wrapping it in a local
 * async function to drive `useOptimistic` — which is what React's own
 * useOptimistic example does — leaves a form that submits nowhere without
 * JavaScript. That was measured with a JS-disabled browser, not assumed: `+`
 * did nothing at all.
 *
 * Optimism stops at the integer count. Line totals and the cart summary come
 * from quote() on the server, because a second money implementation on the
 * client can silently disagree with the first.
 */
export function QuantityStepper({
  productId,
  name,
  quantity,
}: {
  productId: string;
  name: string;
  quantity: number;
}) {
  return (
    <form action={setQuantityAction} className={styles.qtyForm}>
      <input type="hidden" name="productId" value={productId} />
      <StepperControls name={name} quantity={quantity} />
    </form>
  );
}

/**
 * Split out because `useFormStatus` only reports on a form it is rendered
 * inside — called in the component that owns the <form> it would always read
 * idle.
 */
function StepperControls({
  name,
  quantity,
}: {
  name: string;
  quantity: number;
}) {
  const { pending, data } = useFormStatus();

  // The in-flight FormData carries the clicked button's value, so the count
  // can move the instant a button is pressed without a second source of truth.
  // Once the server responds the form goes idle and `quantity` — the freshly
  // revalidated prop — takes over again.
  const submitted = pending ? Number(data?.get("quantity")) : Number.NaN;
  const shown = Number.isInteger(submitted) ? submitted : quantity;

  return (
    <>
      <div className={`${styles.stepper} ${pending ? styles.pending : ""}`}>
        <button
          type="submit"
          name="quantity"
          value={shown - 1}
          className={styles.stepButton}
          // Stops a fast decrement run from deleting the line. Removal is a
          // separate, deliberate control.
          disabled={shown <= 1}
          aria-label={`One fewer ${name}`}
        >
          −
        </button>

        <span className={styles.count} aria-live="polite">
          {shown}
        </span>

        <button
          type="submit"
          name="quantity"
          value={shown + 1}
          className={styles.stepButton}
          disabled={shown >= MAX_LINE_QUANTITY}
          aria-label={`One more ${name}`}
        >
          +
        </button>
      </div>

      <button
        type="submit"
        name="quantity"
        value={0}
        className={styles.remove}
        aria-label={`Remove ${name}`}
      >
        Remove
      </button>
    </>
  );
}
```

Create `src/app/(store)/cart/page.tsx`:

```tsx
import type { Metadata } from "next";
import { getCartId, getCartLines } from "@/lib/cart";
import { quote, FREE_SHIPPING_THRESHOLD_CENTS } from "@/lib/pricing/quote";
import { formatCents } from "@/lib/money";
import { ButtonLink } from "@/components/ui/Button";
import { getActiveDiscount } from "../actions";
import { DiscountForm } from "./DiscountForm";
import { QuantityStepper } from "./QuantityStepper";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Cart" };

export default async function CartPage() {
  const cartId = await getCartId();
  const lines = cartId ? await getCartLines(cartId) : [];
  const discount = await getActiveDiscount();
  const summary = quote(lines, discount);

  if (lines.length === 0) {
    return (
      <div className={styles.page}>
        <h1 className={styles.heading}>Cart</h1>
        <p className={styles.empty}>Your cart is empty.</p>
        <p className={styles.emptyCta}>
          <ButtonLink href="/shop">Shop</ButtonLink>
        </p>
      </div>
    );
  }

  // quote() evaluates free shipping on the post-discount subtotal, so this
  // countdown has to use the same basis or it would promise a threshold the
  // pricing module does not honour.
  const remaining =
    FREE_SHIPPING_THRESHOLD_CENTS -
    (summary.subtotalCents - summary.discountCents);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Cart</h1>

      {lines.map((line) => (
        <div key={line.productId} className={styles.line}>
          <div>
            <div className={styles.lineName}>{line.name}</div>
            <div className={styles.lineUnit}>
              {formatCents(line.unitPriceCents)} each
            </div>
          </div>

          <QuantityStepper
            productId={line.productId}
            name={line.name}
            quantity={line.quantity}
          />

          <div>{formatCents(line.unitPriceCents * line.quantity)}</div>
        </div>
      ))}

      <div className={styles.summary}>
        <DiscountForm applied={discount?.code ?? null} />

        <div className={styles.totals}>
          <div className={styles.row}>
            <span>Subtotal</span>
            <span>{formatCents(summary.subtotalCents)}</span>
          </div>

          {summary.discountCents > 0 && (
            <div className={styles.row}>
              <span>Discount</span>
              <span>-{formatCents(summary.discountCents)}</span>
            </div>
          )}

          <div className={styles.row}>
            <span>Shipping</span>
            <span>
              {summary.shippingCents === 0
                ? "Free"
                : formatCents(summary.shippingCents)}
            </span>
          </div>

          <div className={`${styles.row} ${styles.total}`}>
            <span>Total before tax</span>
            <span>{formatCents(summary.totalCents)}</span>
          </div>

          {remaining > 0 && (
            <p className={styles.note}>
              {formatCents(remaining)} more for free shipping.
            </p>
          )}
          <p className={styles.note}>Tax is calculated at checkout.</p>

          <ButtonLink
            href="/checkout"
            variant="primary"
            block
            className={styles.checkoutCta}
          >
            Checkout
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify in the browser**

Run `npm run dev`, add a bottle to the cart, and confirm: the line renders, quantity updates persist, the subtotal is correct, and adding a sample (total $51) flips shipping to "Free".

- [ ] **Step 5: Commit**

```bash
git add src/app/\(store\)/cart src/app/\(store\)/actions.ts
git commit -m "feat: cart page with discount codes and live totals"
```

---

## Task 14: Checkout with Stripe Elements

**Files:**
- Create: `src/app/(store)/checkout/page.tsx` + `.module.css`, `src/app/(store)/checkout/CheckoutForm.tsx`, `src/app/(store)/checkout/actions.ts`

**Interfaces:**
- Consumes: `createPendingOrder`, `getCartLines`, `getActiveDiscount`, `OutOfStockError`
- Produces: `startCheckoutAction(prev, formData): Promise<CheckoutState>` returning `{ ok: true; clientSecret; orderNumber; email } | { ok: false; error }`

- [ ] **Step 1: Create the checkout Server Action**

Create `src/app/(store)/checkout/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { cookies } from "next/headers";
import { getOrCreateCartId, getCartLines, setQuantity } from "@/lib/cart";
import { getCatalogProductById } from "@/lib/catalog";
import { createPendingOrder } from "@/lib/orders";
import { grantOrderAccess } from "@/lib/orders/access";
import { OutOfStockError } from "@/lib/inventory";
import { PENDING_ORDER_COOKIE } from "@/lib/cookies";
import { getActiveDiscount } from "../actions";
import { getSessionUser } from "@/lib/auth/session";
import type { Address } from "@/lib/db/schema";

const addressSchema = z.object({
  email: z.email("Enter a valid email address."),
  name: z.string().trim().min(1, "Enter a name."),
  line1: z.string().trim().min(1, "Enter a street address."),
  // An untouched optional input still posts "", which would otherwise be
  // stored as a blank second address line.
  line2: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  city: z.string().trim().min(1, "Enter a city."),
  // Letters only, and normalised: Stripe Tax expects a canonical state code,
  // and a plain length check would accept "12" or pass "tx" through as typed.
  state: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter state code.")
    .transform((value) => value.toUpperCase()),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "Enter a valid ZIP code."),
});

export type CheckoutState =
  | { status: "idle" }
  | { status: "error"; error: string; fieldErrors?: Record<string, string> }
  | {
      status: "ready";
      clientSecret: string;
      orderNumber: number;
      email: string;
      totalCents: number;
    };

export async function startCheckoutAction(
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const parsed = addressSchema.safeParse(Object.fromEntries(formData));

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return {
      status: "error",
      error: "Check the highlighted fields.",
      fieldErrors,
    };
  }

  const { email, ...rest } = parsed.data;
  const shippingAddress: Address = { ...rest, country: "US" };

  const cartId = await getOrCreateCartId();
  const lines = await getCartLines(cartId);
  if (lines.length === 0) {
    return { status: "error", error: "Your cart is empty." };
  }

  const discount = await getActiveDiscount();

  // A signed-in buyer's order belongs to their account immediately. A guest's
  // stays unattached until they verify the address.
  const sessionUser = await getSessionUser();

  // Reuse any pending order from an earlier submit on this checkout, so
  // editing an address updates one reservation instead of stacking another.
  // A stale or already-paid id is safe: createPendingOrder verifies the order
  // is still pending with a live reservation before reusing it.
  const jar = await cookies();
  const existingOrderId = jar.get(PENDING_ORDER_COOKIE)?.value ?? null;

  try {
    const { order, clientSecret } = await createPendingOrder({
      cartLines: lines,
      cartId,
      email,
      userId: sessionUser?.id ?? null,
      shippingAddress,
      discount,
      existingOrderId,
    });

    jar.set(PENDING_ORDER_COOKIE, order.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 30,
    });

    // Whoever created this order may view it. Granted here rather than after
    // payment because the confirmation page is also where an unpaid order
    // reports its status, and the webhook has no access to this cookie jar.
    await grantOrderAccess(order.id);

    return {
      status: "ready",
      clientSecret,
      orderNumber: order.orderNumber,
      email: order.email,
      totalCents: order.totalCents,
    };
  } catch (error) {
    if (error instanceof OutOfStockError) {
      // The spec requires a specific message naming the product, and the cart
      // corrected to what is actually available — a generic "something sold
      // out" leaves the customer to guess which line to fix.
      const product = await getCatalogProductById(error.productId);

      if (!product) {
        return {
          status: "error",
          error: "An item in your cart is no longer available. Check your cart.",
        };
      }

      await setQuantity(cartId, product.id, product.available);

      return {
        status: "error",
        error:
          product.available === 0
            ? `${product.name} just sold out. We removed it from your cart.`
            : `Only ${product.available} left of ${product.name}. We updated your cart.`,
      };
    }
    // Stripe Tax failures land here. Blocking is deliberate: charging a guessed
    // tax amount is worse than asking the customer to retry.
    console.error("[checkout] failed to start", error);
    return {
      status: "error",
      error: "We couldn't start checkout. Try again in a moment.",
    };
  }
}
```

- [ ] **Step 2: Build the checkout client component**

Create `src/app/(store)/checkout/CheckoutForm.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { formatCents } from "@/lib/money";
import { startCheckoutAction, type CheckoutState } from "./actions";
import styles from "./page.module.css";

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
);

/**
 * Hexes are duplicated from tokens.css because the Payment Element renders in
 * a cross-origin iframe and cannot read our CSS custom properties. Keep these
 * in step with the tokens: text-bright, panel, text-dim, line-bright, danger.
 */
const appearance = {
  theme: "night" as const,
  variables: {
    colorPrimary: "#d2d5da",
    colorBackground: "#17171b",
    colorText: "#d2d5da",
    colorTextSecondary: "#8d9198",
    colorTextPlaceholder: "#8d9198",
    colorDanger: "#e0645c",
    borderRadius: "2px",
    fontFamily: "system-ui, sans-serif",
  },
  rules: {
    ".Input": { border: "1px solid #65666e" },
  },
};

export function CheckoutForm() {
  const [state, action, pending] = useActionState<CheckoutState, FormData>(
    startCheckoutAction,
    { status: "idle" },
  );

  if (state.status === "ready") {
    return (
      <Elements
        stripe={stripePromise}
        options={{ clientSecret: state.clientSecret, appearance }}
      >
        <PaymentStep
          orderNumber={state.orderNumber}
          email={state.email}
          totalCents={state.totalCents}
        />
      </Elements>
    );
  }

  const fieldErrors = state.status === "error" ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={action} className={styles.form}>
      {state.status === "error" && !state.fieldErrors && (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      )}

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={fieldErrors.email}
      />
      <Field
        label="Full name"
        name="name"
        autoComplete="name"
        required
        error={fieldErrors.name}
      />
      <Field
        label="Address"
        name="line1"
        autoComplete="address-line1"
        required
        error={fieldErrors.line1}
      />
      <Field
        label="Apt, suite (optional)"
        name="line2"
        autoComplete="address-line2"
      />
      <Field
        label="City"
        name="city"
        autoComplete="address-level2"
        required
        error={fieldErrors.city}
      />
      <Field
        label="State"
        name="state"
        autoComplete="address-level1"
        maxLength={2}
        required
        error={fieldErrors.state}
      />
      <Field
        label="ZIP"
        name="postalCode"
        autoComplete="postal-code"
        inputMode="numeric"
        required
        error={fieldErrors.postalCode}
      />

      <p className={styles.shippingNote}>
        We ship ground within the US only. Fragrance cannot travel by air.
      </p>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Calculating" : "Continue to payment"}
      </Button>
    </form>
  );
}

function PaymentStep({
  orderNumber,
  email,
  totalCents,
}: {
  orderNumber: number;
  email: string;
  totalCents: number;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // No email in the URL: access is carried by the httpOnly cookie the
  // checkout action set, so the confirmation page keeps the customer's
  // address out of browser history, access logs and referrer headers.
  const confirmationUrl = `/order/${orderNumber}`;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    setError(null);

    const result = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}${confirmationUrl}`,
      },
      redirect: "if_required",
    });

    if (result.error) {
      // A declined card leaves the PaymentIntent reusable, so drop back into
      // the form rather than tearing the Element down.
      setError(result.error.message ?? "Payment failed. Try another card.");
      setSubmitting(false);
      return;
    }

    // replace, not push: the back button must not return to a checkout form
    // for an order that has already been paid. refresh re-renders the shared
    // store layout so the header's cart count reflects the cleared cart.
    router.replace(confirmationUrl);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className={styles.paymentForm}>
      <div className={styles.summary}>
        <p className={styles.total}>Total {formatCents(totalCents)}</p>
        <p className={styles.receiptNote}>A receipt will go to {email}.</p>
      </div>

      <PaymentElement />

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={!stripe || submitting}>
        {submitting ? "Processing" : `Pay ${formatCents(totalCents)}`}
      </Button>
    </form>
  );
}
```

- [ ] **Step 3: Build the checkout page**

Create `src/app/(store)/checkout/page.module.css`:

```css
.page {
  max-width: 560px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.heading {
  font-size: 0.7rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
  font-weight: 400;
  margin-bottom: var(--space-5);
}

.form {
  display: grid;
  gap: var(--space-4);
}

.paymentForm {
  display: grid;
  gap: var(--space-5);
}

/* Total and receipt note read as one block, so they sit closer than the
   form's row gap. */
.summary {
  display: grid;
  gap: var(--space-2);
}

.error {
  color: var(--danger);
}

.shippingNote {
  color: var(--text-faint);
  font-size: 0.8rem;
}

.total {
  color: var(--text-bright);
}

.receiptNote {
  color: var(--text-faint);
  font-size: 0.8rem;
}
```

Create `src/app/(store)/checkout/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCartId, getCartLines } from "@/lib/cart";
import { CheckoutForm } from "./CheckoutForm";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage() {
  const cartId = await getCartId();
  const lines = cartId ? await getCartLines(cartId) : [];
  if (lines.length === 0) redirect("/cart");

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Checkout</h1>
      <CheckoutForm />
    </div>
  );
}
```

- [ ] **Step 4: Verify with a Stripe test card**

Run `npm run dev`, add a bottle, go to `/checkout`, fill the address, and confirm the Payment Element renders in dark theme. Pay with `4242 4242 4242 4242`, any future expiry, any CVC. The redirect to `/order/<number>` will 404 until Task 16.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(store\)/checkout
git commit -m "feat: checkout with embedded Stripe Elements"
```

---

## Task 15: Stripe webhook

**Files:**
- Create: `src/app/api/stripe/webhook/route.ts`, `src/app/api/cron/release-reservations/route.ts`

**Interfaces:**
- Consumes: `getPayments`, `markOrderPaid`, `findOrderById`, `sendOrderConfirmation`, `releaseExpiredReservations`
- Produces: `POST /api/stripe/webhook`, `GET /api/cron/release-reservations`

- [ ] **Step 1: Implement the webhook route**

Create `src/app/api/stripe/webhook/route.ts`:

```ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, stripeEvents } from "@/lib/db/schema";
import { getPayments } from "@/lib/payments";
import { markOrderPaid, findOrderById } from "@/lib/orders";
import { recordRefund } from "@/lib/orders/refund";
import { sendOrderConfirmation } from "@/lib/email";
import { clearCart } from "@/lib/cart";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  // The raw body is required for signature verification — do not parse first.
  const rawBody = await request.text();

  let event;
  try {
    event = getPayments().verifyWebhook(rawBody, signature);
  } catch (error) {
    console.error("[webhook] signature verification failed", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        if (!event.paymentIntentId) break;

        // markOrderPaid owns idempotency via the stripe_events ledger; null
        // means this event was already processed.
        const order = await markOrderPaid(event.paymentIntentId, event.id);
        if (order) await completePaidOrder(order.id, order.cartId);
        break;
      }

      case "payment_intent.payment_failed": {
        if (!event.paymentIntentId) break;
        await handleFailure(event.id, event.paymentIntentId);
        break;
      }

      case "charge.refunded": {
        if (!event.paymentIntentId || event.amountCents === null) {
          // Acknowledged rather than retried: a refund we cannot tie to a
          // payment intent will not become tieable on a second delivery, so
          // a non-2xx would just retry forever. But it is real money moving
          // with no order we can find, so it must not pass in silence.
          console.error("[webhook] charge.refunded without a usable intent", {
            eventId: event.id,
            paymentIntentId: event.paymentIntentId,
            amountCents: event.amountCents,
          });
          break;
        }

        // amountCents is amount_refunded -- the cumulative total for the
        // charge, which is why recordRefund sets rather than accumulates.
        // Letting this throw is deliberate: it produces a non-2xx, rolls back
        // the ledger row, and has Stripe retry. Money that moved with no
        // order behind it must never be answered with a 200.
        await recordRefund(event.paymentIntentId, event.id, event.amountCents);
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    // Non-2xx makes Stripe retry, which the idempotency ledger makes safe.
    //
    // DO NOT narrow this catch or convert it to a 200. markOrderPaid throws
    // StrandedPaymentError and OrderNotFoundForPaymentError precisely so they
    // reach here and produce a non-2xx: throwing rolls back the stripe_events
    // insert, so Stripe retries and eventually surfaces the event in its
    // dashboard. Swallowing them returns 200 for a real charge that has no
    // order behind it, and the money is then lost with nothing to reconcile.
    console.error("[webhook] handler failed", { type: event.type, error });
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }
}

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
 * Both effects are recoverable by other means: a stale cart is corrected on
 * the customer's next visit, and a missing confirmation email can be resent.
 */
async function completePaidOrder(
  orderId: string,
  cartId: string | null,
): Promise<void> {
  try {
    // Empty the cart that produced this order. The webhook is the only
    // authoritative "payment succeeded" signal — clearing client-side after
    // confirmPayment would leave a full cart behind whenever the customer
    // closes the tab, letting them re-purchase by accident.
    if (cartId) await clearCart(cartId);

    const full = await findOrderById(orderId);
    if (full) await sendOrderConfirmation(full);
  } catch (error) {
    console.error("[webhook] post-payment side effects failed", {
      orderId,
      error,
    });
  }
}

async function handleFailure(eventId: string, paymentIntentId: string) {
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: eventId, type: "payment_intent.payment_failed" })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });

    if (inserted.length === 0) return;

    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (!order || order.status !== "pending") return;

    // Deliberately does NOT change status or release stock.
    //
    // A declined card is not the end of the checkout — the customer is still
    // on the page and Stripe lets them retry the SAME PaymentIntent with
    // another card. Three things would break if we mutated here:
    //
    //   1. Releasing the reservation lets someone else take the last bottle
    //      while the customer is typing a second card number.
    //   2. markOrderPaid only transitions orders that are still `pending`,
    //      so a successful retry on this PaymentIntent would find nothing to
    //      mark paid — the customer gets charged and no order is recorded.
    //   3. createPendingOrder only reuses orders that are `pending` with a
    //      live reservation, so a retry would strand this order entirely.
    //
    // The reservation expires on its own 15-minute schedule, and the sweep in
    // releaseExpiredReservations cancels the order then. That is the only
    // path that should retire an unpaid order.
    console.warn("[webhook] payment failed, order left pending for retry", {
      orderId: order.id,
      paymentIntentId,
    });
  });
}
```

- [ ] **Step 2: Implement the reservation sweep route**

Create `src/app/api/cron/release-reservations/route.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { releaseExpiredReservations } from "@/lib/inventory";

function isAuthorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;

  // Fail closed. Without this the comparison below would be against the
  // literal string "Bearer undefined", which anyone could send.
  if (!secret) {
    console.error("[cron] CRON_SECRET is not set; refusing to run");
    return false;
  }

  if (!header) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  // timingSafeEqual throws on a length mismatch, so check that first — the
  // length of the secret is not itself worth protecting.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function GET(request: Request) {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const released = await releaseExpiredReservations();
  return NextResponse.json({ released });
}
```

- [ ] **Step 3: Schedule the cron**

Superseded. `vercel.json` was deleted on 2026-09-23: the store deploys to
Railway, which ignores that file, so the schedule it declared never ran and
expired reservations were never released. The schedule now lives in a Railway
cron service running `npm run cron:release-reservations`. See
`docs/superpowers/plans/2026-09-23-railway-reservation-cron.md`.

- [ ] **Step 4: Test the webhook against the local server**

In one terminal: `npm run dev`
In another:

```bash
stripe listen \
  --events payment_intent.succeeded,payment_intent.payment_failed,charge.refunded \
  --forward-to localhost:3000/api/stripe/webhook
```

Copy the printed `whsec_...` into `.env` as `STRIPE_WEBHOOK_SECRET`, restart the dev server, then place a test order through `/checkout`.

Expected: the `stripe listen` terminal shows `payment_intent.succeeded [200]`. Confirm in the database that the order status is `paid`, `inventory_state` is `committed`, and `on_hand` dropped by one.

- [ ] **Step 5: Verify idempotency by replaying the event**

```bash
stripe events resend <event_id>
```

Expected: 200 again, and `on_hand` is unchanged from the previous step.

- [ ] **Step 6: Commit**

```bash
git add src/app/api
git commit -m "feat: Stripe webhook with idempotency and reservation sweep"
```

---

## Task 16: Order confirmation and guest order lookup

**Files:**
- Create: `src/lib/orders/access.ts`, `src/app/(store)/order/[number]/page.tsx` + `.module.css`, `src/app/(store)/order/[number]/PendingNotice.tsx`, `src/app/(store)/order-lookup/page.tsx`, `src/app/(store)/order-lookup/actions.ts`

**Interfaces:**
- Consumes: `findOrderByNumberForIds`, `parseOrderNumber`, `formatOrderNumber`, `formatCents`
- Produces: `lookupOrderAction(prev, formData): Promise<{ error?: string }>` (redirects on success); `grantOrderAccess` / `readGrantedOrderIds`

- [ ] **Step 0: Build the order-access module**

The confirmation page must not take the customer's email as a query
parameter. It renders a full shipping address, and a URL lands in browser
history, server access logs and any outbound referrer. Access is carried by
an httpOnly cookie instead.

The cookie holds order **ids**, not order numbers. `orders.id` is a v4 UUID,
so the cookie value is itself the unguessable credential — httpOnly stops
page scripts from reading it, but nothing stops a hand-written request from
sending whatever it likes, so a cookie naming `CS-1000` would grant anyone
access to order 1000.

Create `src/lib/orders/access.ts`:

```ts
import { cookies } from "next/headers";
import { ORDER_ACCESS_COOKIE } from "@/lib/cookies";

/**
 * How many recent orders a browser keeps access to. A customer who orders
 * repeatedly should not silently lose the confirmation page for the previous
 * one, but the cookie must not grow without bound either.
 */
const MAX_REMEMBERED_ORDERS = 10;

const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function parse(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, MAX_REMEMBERED_ORDERS);
}

/**
 * Order ids this browser may view. Safe to call while rendering a Server
 * Component — it only reads.
 *
 * These ids are untrusted input: anything could be in the cookie. They are
 * only ever used as an equality filter against a specific order number, so a
 * forged value has to be a correct UUID guess to grant anything.
 */
export async function readGrantedOrderIds(): Promise<string[]> {
  const jar = await cookies();
  return parse(jar.get(ORDER_ACCESS_COOKIE)?.value);
}

/**
 * Remembers that this browser may view an order. Most recent first, so the
 * cap evicts the oldest.
 *
 * WRITES A COOKIE — callable only from a Server Action or Route Handler.
 */
export async function grantOrderAccess(orderId: string): Promise<void> {
  const jar = await cookies();
  const existing = parse(jar.get(ORDER_ACCESS_COOKIE)?.value);

  const next = [orderId, ...existing.filter((id) => id !== orderId)].slice(
    0,
    MAX_REMEMBERED_ORDERS,
  );

  jar.set(ORDER_ACCESS_COOKIE, next.join(","), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
}
```

- [ ] **Step 1: Build the pending-state client component**

Create `src/app/(store)/order/[number]/PendingNotice.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

/**
 * The webhook usually lands within a second or two of the customer arriving
 * here, so refresh a few times before giving up rather than showing a
 * misleading "not paid" state.
 */
export function PendingNotice() {
  const router = useRouter();

  useEffect(() => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      router.refresh();
      if (attempts >= 5) clearInterval(timer);
    }, 2000);

    return () => clearInterval(timer);
  }, [router]);

  return (
    <p role="status" className={styles.pending}>
      Confirming your payment. This takes a moment.
    </p>
  );
}
```

- [ ] **Step 2: Build the order page**

Create `src/app/(store)/order/[number]/page.module.css`:

```css
.page {
  max-width: 640px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-4);
}

.status {
  font-size: 0.7rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
}

.number {
  margin-top: var(--space-2);
  font-size: 1.6rem;
  font-weight: 200;
  color: var(--text-bright);
}

.pending,
.thanks {
  margin-top: var(--space-3);
  color: var(--text-dim);
}

.line,
.row {
  display: flex;
  justify-content: space-between;
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--line);
}

.row {
  border-bottom: none;
  padding: var(--space-1) 0;
}

.section {
  margin-top: var(--space-5);
}

.label {
  font-size: 0.68rem;
  letter-spacing: var(--track-mid);
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: var(--space-3);
}

.total {
  border-top: 1px solid var(--line);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  color: var(--text-bright);
}
```

Create `src/app/(store)/order/[number]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  findOrderByNumberForIds,
  parseOrderNumber,
  formatOrderNumber,
} from "@/lib/orders";
import { readGrantedOrderIds } from "@/lib/orders/access";
import { formatCents } from "@/lib/money";
import { PendingNotice } from "./PendingNotice";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Your order" };

const STATUS_COPY: Record<string, string> = {
  pending: "Awaiting payment",
  paid: "Confirmed",
  fulfilled: "Shipped",
  payment_failed: "Payment failed",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

export default async function OrderPage({
  params,
}: PageProps<"/order/[number]">) {
  const { number } = await params;

  const orderNumber = parseOrderNumber(number);
  if (orderNumber === null) notFound();

  // Access comes from an httpOnly cookie holding the order's id, not from a
  // query parameter. The customer's email used to travel in the URL, which
  // put it in browser history, server access logs and outbound referrers on a
  // page that renders their full shipping address.
  //
  // Anyone without the cookie — including the customer on another device —
  // re-enters through /order-lookup, which re-establishes it.
  const granted = await readGrantedOrderIds();
  const order = await findOrderByNumberForIds(orderNumber, granted);

  // 404, not a redirect to the lookup form: a distinguishable response would
  // confirm which order numbers exist.
  if (!order) notFound();

  const address = order.shippingAddress;

  return (
    <div className={styles.page}>
      <p className={styles.status}>
        {STATUS_COPY[order.status] ?? order.status}
      </p>
      <h1 className={styles.number}>{formatOrderNumber(order.orderNumber)}</h1>

      {order.status === "pending" && <PendingNotice />}

      {order.status === "paid" && (
        <p className={styles.thanks}>
          Thank you. We&apos;ll email you when it ships.
        </p>
      )}

      <div className={styles.section}>
        <p className={styles.label}>Items</p>
        {order.items.map((item) => (
          <div key={item.id} className={styles.line}>
            <span>
              {item.name} × {item.quantity}
            </span>
            <span>{formatCents(item.totalCents)}</span>
          </div>
        ))}

        <div className={styles.row}>
          <span>Subtotal</span>
          <span>{formatCents(order.subtotalCents)}</span>
        </div>
        {order.discountCents > 0 && (
          <div className={styles.row}>
            <span>Discount</span>
            <span>-{formatCents(order.discountCents)}</span>
          </div>
        )}
        <div className={styles.row}>
          <span>Shipping</span>
          <span>
            {order.shippingCents === 0
              ? "Free"
              : formatCents(order.shippingCents)}
          </span>
        </div>
        <div className={styles.row}>
          <span>Tax</span>
          <span>{formatCents(order.taxCents)}</span>
        </div>
        <div className={`${styles.row} ${styles.total}`}>
          <span>Total</span>
          <span>{formatCents(order.totalCents)}</span>
        </div>
      </div>

      <div className={styles.section}>
        <p className={styles.label}>Shipping to</p>
        <p>
          {address.name}
          <br />
          {address.line1}
          {address.line2 && (
            <>
              <br />
              {address.line2}
            </>
          )}
          <br />
          {address.city}, {address.state} {address.postalCode}
        </p>
      </div>

      {order.trackingNumber && (
        <div className={styles.section}>
          <p className={styles.label}>Tracking</p>
          <p>
            {order.carrier} {order.trackingNumber}
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build the order lookup action**

Create `src/app/(store)/order-lookup/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { findOrderByNumber, parseOrderNumber } from "@/lib/orders";
import { grantOrderAccess } from "@/lib/orders/access";

export type LookupState = { error?: string };

export async function lookupOrderAction(
  _prev: LookupState,
  formData: FormData,
): Promise<LookupState> {
  const rawNumber = String(formData.get("orderNumber") ?? "");
  const email = String(formData.get("email") ?? "").trim();

  const orderNumber = parseOrderNumber(rawNumber);
  if (orderNumber === null || !email) {
    return { error: "Enter your order number and the email you used." };
  }

  const order = await findOrderByNumber(orderNumber, email);
  if (!order) {
    // Deliberately vague — do not confirm whether an order number exists.
    return { error: "We couldn't find that order. Check both fields." };
  }

  // The email proved ownership here; from now on the cookie carries it, so
  // the address never has to travel in a URL.
  await grantOrderAccess(order.id);

  redirect(`/order/${order.orderNumber}`);
}
```

- [ ] **Step 4: Build the lookup page**

Create `src/app/(store)/order-lookup/page.tsx`:

```tsx
import type { Metadata } from "next";
import { LookupForm } from "./LookupForm";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Find an order" };

export default function OrderLookupPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Find an order</h1>
      <LookupForm />
    </div>
  );
}
```

- [ ] **Step 5: Verify end to end**

Place a test order. Confirm the redirect lands on `/order/CS-1000?email=...` showing "Confirmed" after the webhook fires. Then visit `/order-lookup`, enter the same number and email, and confirm it resolves. Enter a wrong email and confirm it fails without revealing anything.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(store\)/order src/app/\(store\)/order-lookup
git commit -m "feat: order confirmation and guest order lookup"
```

---

## Task 17: End-to-end smoke test

**Files:**
- Create: `playwright.config.ts`, `e2e/checkout.spec.ts`
- Modify: `package.json`, `.gitignore`

**Interfaces:**
- Consumes: the running application
- Produces: npm script `test:e2e`

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Add the config**

Create `playwright.config.ts`:

```ts
// The runner does not inherit .env the way `next dev` does. Without this the
// payment test's "do we have real Stripe keys?" check reads undefined and the
// test skips itself forever, including when the keys are present.
import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    // Locally, reuse whatever server is already up. In CI always start a
    // fresh one: `next build` and `next dev` share the .next directory, and a
    // dev server left running across a build can serve pages that render
    // correctly while Server Action POSTs silently no-op, which shows up as a
    // baffling assertion failure rather than an error.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

- [ ] **Step 3: Add the npm script**

Add to `package.json` scripts:

```json
    "test:e2e": "playwright test",
```

- [ ] **Step 4: Ignore Playwright output**

Append to `.gitignore`:

```
# playwright
/test-results
/playwright-report
/blob-report
```

- [ ] **Step 5: Write the smoke test**

Create `e2e/checkout.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

/** Where the app receives Stripe webhooks; `stripe listen` must forward here. */
const WEBHOOK_PATH = "/api/stripe/webhook";

/**
 * Why the payment test cannot run, or null if it can.
 *
 * Two things are required, and checking only the first is what made this test
 * fail rather than skip: paying needs a real test key (with the .env
 * placeholder the tax call fails and checkout never reaches the Payment
 * Element), and the final assertion — "Confirmed" — only appears once the
 * webhook marks the order paid, which needs `stripe listen` forwarding to this
 * process. With real keys and no listener the test used to run all the way
 * through the card form and then time out 30s later on an assertion about
 * something the code under test had no part in.
 *
 * Known limitation: this confirms a listener is forwarding to the right path,
 * not that the secret it printed matches STRIPE_WEBHOOK_SECRET in .env. A
 * mismatch still fails, loudly, at signature verification — which is the right
 * place for it to fail.
 */
function paymentSkipReason(): string | null {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (key.length <= 40 || key.includes("placeholder")) {
    return "Needs a real STRIPE_SECRET_KEY; .env holds a placeholder.";
  }

  // `ps` rather than pgrep: -a/-l differ between macOS and Linux, and a guard
  // that throws on one platform would skip everywhere for the wrong reason.
  let commands: string[] = [];
  try {
    commands = execFileSync("ps", ["-ax", "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n");
  } catch {
    return "Could not list processes to check for a `stripe listen` listener.";
  }

  const listeners = commands.filter((c) => /\bstripe\b.*\blisten\b/.test(c));
  if (listeners.length === 0) {
    return `No \`stripe listen\` is running; the webhook cannot reach ${WEBHOOK_PATH}, so the order never becomes "Confirmed".`;
  }
  if (!listeners.some((c) => c.includes(WEBHOOK_PATH))) {
    return `A \`stripe listen\` is running but none forwards to ${WEBHOOK_PATH} — check its --forward-to.`;
  }

  return null;
}

const PAYMENT_SKIP_REASON = paymentSkipReason();

const ADDRESS = {
  Email: "buyer@example.com",
  "Full name": "Test Buyer",
  Address: "1 Powder Lane",
  City: "Bozeman",
  State: "MT",
  ZIP: "59715",
};

async function addBottleToCart(page: import("@playwright/test").Page) {
  await page.goto("/shop");
  await expect(page.getByText("Coldsmoke Eau de Toilette")).toBeVisible();

  await page.getByText("Coldsmoke Eau de Toilette").click();
  await expect(page.getByRole("button", { name: "Add to cart" })).toBeVisible();
  await page.getByRole("button", { name: "Add to cart" }).click();

  await expect(page).toHaveURL(/\/cart/);
}

test("a guest can fill a cart and reach the checkout form", async ({ page }) => {
  await addBottleToCart(page);

  await expect(page.getByText("$45.00").first()).toBeVisible();
  // $45 is under the $50 free-shipping threshold.
  await expect(page.getByText("$6.00").first()).toBeVisible();

  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout/);

  for (const [label, value] of Object.entries(ADDRESS)) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }

  await expect(
    page.getByRole("button", { name: "Continue to payment" }),
  ).toBeEnabled();
});

test("the cart survives a reload and totals recalculate", async ({ page }) => {
  await addBottleToCart(page);

  await page.getByRole("button", { name: /^One more / }).click();

  // Wait for the SERVER-rendered total before reloading, or the reload races
  // the re-render and reads the pre-update cart.
  //
  // Not the stepper's count: it is optimistic, so it shows 2 the instant the
  // button is clicked whether or not the action landed. Asserting it passes
  // either way, which is worse than not asserting at all.
  await expect(page.getByText("$90.00").first()).toBeVisible();

  await page.reload();
  // Still $90 after a round trip, and two bottles clears free shipping.
  await expect(page.getByText("$90.00").first()).toBeVisible();
  await expect(page.getByText("Free")).toBeVisible();
});

test("the stepper changes quantity and price without an update button", async ({
  page,
}) => {
  await addBottleToCart(page);

  const subtotal = async () =>
    (await page.locator("main").innerText()).match(/Subtotal\s*\$([0-9.,]+)/)?.[1];

  await expect(page.getByRole("button", { name: "Update" })).toHaveCount(0);
  expect(await subtotal()).toBe("45.00");

  await page.getByRole("button", { name: /^One more / }).click();
  // Two bottles is $90, which also clears the free-shipping threshold.
  await expect(page.getByText("$90.00").first()).toBeVisible();
  await expect(page.getByText("Free")).toBeVisible();

  await page.getByRole("button", { name: /^One fewer / }).click();
  // Not getByText("$45.00"): the unit price renders as "$45.00 each" and is
  // visible at every quantity, so that assertion passes before the server has
  // done anything and the subtotal read below races it. The subtotal is the
  // only figure here that actually moves.
  await expect.poll(subtotal).toBe("45.00");
});

test("the stepper cannot delete a line", async ({ page }) => {
  await addBottleToCart(page);

  // Removal is a separate, deliberate control, so one click past the end of a
  // decrement run must not empty the cart.
  await expect(page.getByRole("button", { name: /^One fewer / })).toBeDisabled();
  await expect(page.getByText("Your cart is empty.")).toHaveCount(0);
});

test("Remove clears the line", async ({ page }) => {
  await addBottleToCart(page);

  await page.getByRole("button", { name: /^Remove / }).click();

  await expect(page.getByText("Your cart is empty.")).toBeVisible();
});

test("an empty cart cannot reach checkout", async ({ page }) => {
  await page.context().clearCookies();
  await page.goto("/checkout");
  await expect(page).toHaveURL(/\/cart/);
  await expect(page.getByText("Your cart is empty.")).toBeVisible();
});

test("a guest can buy a bottle", async ({ page }) => {
  test.skip(PAYMENT_SKIP_REASON !== null, PAYMENT_SKIP_REASON ?? "");

  await addBottleToCart(page);
  await expect(page.getByText("$45.00").first()).toBeVisible();

  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout/);

  for (const [label, value] of Object.entries(ADDRESS)) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }

  await page.getByRole("button", { name: "Continue to payment" }).click();

  // The Payment Element renders in a Stripe-hosted iframe. Two iframes share
  // the title "Secure payment input frame", so disambiguate with .first()
  // rather than frameLocator, which is strict and would throw.
  const stripeFrame = page
    .locator("iframe[title='Secure payment input frame']")
    .first()
    .contentFrame();

  // The account has several payment methods enabled, so the Element opens on
  // a method picker and the card fields do not exist until Card is chosen.
  await stripeFrame.getByRole("button", { name: "Card", exact: true }).click();

  await stripeFrame
    .getByPlaceholder("1234 1234 1234 1234")
    .fill("4242424242424242");
  await stripeFrame
    .getByPlaceholder("MM / YY")
    .fill("12" + String(new Date().getFullYear() + 2).slice(-2));
  await stripeFrame.getByPlaceholder("CVC").fill("123");
  await stripeFrame.getByPlaceholder("12345").fill("59715");

  // Selecting Card expands the Element by ~570px, which pushes Pay far below
  // the fold. Playwright's auto-scroll races that reflow and the click lands
  // on nothing — silently, because a missed click is not an error. Scroll and
  // let it settle first.
  const pay = page.getByRole("button", { name: /^Pay / });
  await pay.scrollIntoViewIfNeeded();
  await expect(pay).toBeInViewport();
  await pay.click();

  await expect(page).toHaveURL(/\/order\/\d+/, { timeout: 30_000 });

  // getByText would also match Next's route announcer, which mirrors the
  // heading into an aria-live region.
  await expect(page.getByRole("heading", { name: /CS-\d+/ })).toBeVisible();

  // The order lands as "Awaiting payment" and only becomes "Confirmed" once
  // the webhook marks it paid, so this is the assertion that actually proves
  // the paid transition rather than just the redirect. Requires
  // `stripe listen` to be forwarding; PendingNotice polls for ~10s.
  await expect(page.getByText("Confirmed")).toBeVisible({ timeout: 30_000 });
});
```

- [ ] **Step 6: Run the smoke test**

Ensure `stripe listen` is forwarding to `/api/stripe/webhook` (see Task 15), then:

```bash
npm run test:e2e
```

Expected: PASS. If the Stripe iframe placeholders differ from those above, open the trace with `npx playwright show-trace` and update the selectors to match what the Element actually renders.

- [ ] **Step 7: Commit**

```bash
git add playwright.config.ts e2e package.json package-lock.json .gitignore
git commit -m "test: end-to-end guest checkout smoke test"
```

---

## Task 18: Full test suite and README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything built above
- Produces: project documentation

- [ ] **Step 1: Run the whole suite**

```bash
npm run db:test:up
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all unit and integration tests pass, no type errors, no lint errors, clean production build. Fix anything that fails before continuing.

- [ ] **Step 2: Replace the scaffold README**

Replace the contents of `README.md`:

````markdown
# Coldsmoke

Storefront and marketing site for Coldsmoke, a cool-spice-and-smoke cologne.

Next.js (App Router) · Postgres + Drizzle · Stripe Elements · Resend

## Setup

```bash
npm install
cp .env.example .env    # fill in real values
npm run db:migrate
npm run db:seed
npm run dev
```

## Architecture

Store logic lives in `src/lib/` modules with explicit interfaces. Pages and
Server Actions are thin callers.

- `lib/pricing/quote.ts` is the **only** place money is computed. The cart, the
  PaymentIntent, and the webhook all call it, so they cannot disagree.
- `lib/payments/` is the **only** place that imports the Stripe SDK. Tests use
  `FakePayments` instead.
- `lib/inventory/` guards stock in SQL WHERE clauses, so Postgres decides races
  between concurrent buyers.
- The Stripe webhook is the only writer of order status `paid`, and is
  idempotent via the `stripe_events` ledger.

All money is integer cents. `formatCents` is for display only.

## Testing

```bash
npm run db:test:up      # throwaway Postgres on port 54329
npm test                # unit + integration
npm run test:e2e        # Playwright smoke test
npm run db:test:down
```

## Webhooks in development

```bash
stripe listen \
  --events payment_intent.succeeded,payment_intent.payment_failed,charge.refunded \
  --forward-to localhost:3000/api/stripe/webhook
```

Put the printed `whsec_...` in `.env` as `STRIPE_WEBHOOK_SECRET`.

## Deployment

Railway. Set every variable from `.env.example` in the service settings, and
add the production webhook endpoint in the Stripe dashboard pointing at
`/api/stripe/webhook`. `NEXT_PUBLIC_*` variables must be set before the build,
because Next.js inlines them into the client bundle at build time. Expired
reservations are swept by a separate Railway cron service — see
`docs/superpowers/plans/2026-09-23-railway-reservation-cron.md`.

## Plans

- Plan 1 (this) — storefront and guest checkout
- Plan 2 — customer accounts (Better Auth)
- Plan 3 — admin panel
- Plan 4 — marketing pages and brand polish

See `docs/superpowers/specs/` and `docs/superpowers/plans/`.
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: project README"
```

---

## Self-Review

**Spec coverage.** Every Section 1–9 requirement in the spec maps to a task here, except the four deferred by design: customer accounts and saved addresses (Plan 2), the admin panel (Plan 3), and the marketing/legal pages (Plan 4). Within this plan's scope: the modular architecture is Tasks 3–10, the data model is Task 2, checkout and its invariants are Tasks 8, 9, 14, and 15, inventory concurrency is Task 6, error handling is distributed across Tasks 14–16, and the testing strategy is Tasks 3, 4, 6, 7, and 17.

**Two gaps found and closed:** Task 15 now handles `payment_intent.payment_failed` (the spec's decline path), and Task 16 requires an email alongside the order number so an order number alone cannot expose a customer's address.

**Known rough edges for the implementer.** The Stripe `apiVersion` in Task 8 may need to match whatever the installed SDK's types expect. The Playwright selectors in Task 17 target Stripe's iframe internals and are the most likely thing in this plan to need adjustment against the live Element. The `vi.mock` setup in Task 7's cart tests routes the module's `db` import at the test database; if module resolution fights you there, refactor `getCartLines` and friends to take a `db` parameter rather than contorting the mock.

**Deviations from the spec** are declared in Global Constraints rather than applied silently.
