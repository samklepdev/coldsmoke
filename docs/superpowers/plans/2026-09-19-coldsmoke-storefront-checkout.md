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
  --line-bright: #4a4b51;

  --text: #b7bbc1;
  --text-dim: #8d9198;
  --text-bright: #d2d5da;
  --text-faint: #63666d;

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
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 2: Define the schema**

Create `src/lib/db/schema.ts`:

```ts
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
} from "drizzle-orm/pg-core";

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
  (t) => [uniqueIndex("discount_codes_code_idx").on(t.code)],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderNumber: integer("order_number")
      .notNull()
      .generatedByDefaultAsIdentity({ startWith: 1000 }),
    userId: text("user_id"),
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

    shippingAddress: jsonb("shipping_address").notNull(),
    billingAddress: jsonb("billing_address"),

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
  },
  (t) => [
    uniqueIndex("orders_number_idx").on(t.orderNumber),
    uniqueIndex("orders_payment_intent_idx").on(t.stripePaymentIntentId),
    index("orders_email_idx").on(t.email),
    index("orders_status_idx").on(t.status),
  ],
);

export const orderItems = pgTable("order_items", {
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
});

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Product = typeof products.$inferSelect;
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

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// postgres.js rather than the Neon HTTP driver: inventory reservation needs
// real multi-statement transactions, which the HTTP driver does not support.
const client = postgres(connectionString, { max: 10 });

export const db = drizzle(client, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
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
import { db } from "./client";
import { products, inventory } from "./schema";

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
  },
];

async function main() {
  for (const item of SEED) {
    const { onHand, ...product } = item;
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
    expect(q.totalCents).toBeGreaterThanOrEqual(0);
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
    lines,
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
 */
export async function redeemDiscount(
  tx: Tx,
  discountCodeId: string,
): Promise<void> {
  await tx
    .update(discountCodes)
    .set({ timesRedeemed: sql`${discountCodes.timesRedeemed} + 1` })
    .where(
      sql`${discountCodes.id} = ${discountCodeId} AND (${discountCodes.maxRedemptions} IS NULL OR ${discountCodes.timesRedeemed} < ${discountCodes.maxRedemptions})`,
    );
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

export async function getActiveProducts(): Promise<CatalogProduct[]> {
  const rows = await db
    .select({
      product: products,
      available: sql<number>`GREATEST(${inventory.onHand} - ${inventory.reserved}, 0)`,
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
    available: Number(row.available ?? 0),
    images: images.filter((image) => image.productId === row.product.id),
  }));
}

export async function getProductBySlug(
  slug: string,
): Promise<CatalogProduct | null> {
  const [row] = await db
    .select({
      product: products,
      available: sql<number>`GREATEST(${inventory.onHand} - ${inventory.reserved}, 0)`,
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
    available: Number(row.available ?? 0),
    images,
  };
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
                 inventory, product_images, products, discount_codes, stripe_events
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
import { db, type Tx } from "@/lib/db/client";
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

/** Returns reserved units to the available pool. Idempotent. */
export async function releaseStock(tx: Tx, orderId: string): Promise<void> {
  const claimed = await claimInventoryState(tx, orderId, "reserved", "released");
  if (!claimed) return;

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
 */
export async function releaseExpiredReservations(): Promise<number> {
  const expired = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "pending"),
        eq(orders.inventoryState, "reserved"),
        lt(orders.reservationExpiresAt, new Date()),
      ),
    );

  for (const order of expired) {
    await db.transaction(async (tx) => {
      await releaseStock(tx, order.id);
      await tx
        .update(orders)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(eq(orders.id, order.id));
    });
  }

  return expired.length;
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
- Create: `src/lib/cart/index.ts`, `src/lib/cart/cart.test.ts`

**Interfaces:**
- Consumes: `db`, `carts`, `cartItems`, `getProductsByIds`, `quote`
- Produces:
  - `CART_COOKIE = "cs_cart"`
  - `getOrCreateCartId(): Promise<string>` (reads/writes the cookie)
  - `getCartLines(cartId: string): Promise<QuoteLine[]>`
  - `addItem(cartId: string, productId: string, quantity: number): Promise<void>`
  - `setQuantity(cartId: string, productId: string, quantity: number): Promise<void>`
  - `clearCart(cartId: string): Promise<void>`

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

- [ ] **Step 3: Implement the cart module**

Create `src/lib/cart/index.ts`:

```ts
import { cookies } from "next/headers";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { carts, cartItems } from "@/lib/db/schema";
import { getProductsByIds } from "@/lib/catalog";
import type { QuoteLine } from "@/lib/pricing/quote";

export const CART_COOKIE = "cs_cart";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * Resolves the caller's cart, creating one if needed. Guest carts are
 * identified by a uuid in an httpOnly cookie; Plan 2 attaches userId on
 * sign-in and merges.
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

// This is the ONLY file permitted to import the stripe package.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-10-29.clover",
});

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

    const calculation = await stripe.tax.calculations.create({
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

    const intent = paymentIntentId
      ? await stripe.paymentIntents.update(paymentIntentId, {
          amount: amountCents,
          receipt_email: email,
          metadata,
        })
      : await stripe.paymentIntents.create({
          amount: amountCents,
          currency: "usd",
          receipt_email: email,
          metadata,
          automatic_payment_methods: { enabled: true },
        });

    return {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret!,
    };
  }

  async refund({
    paymentIntentId,
    amountCents,
  }: Parameters<PaymentsAdapter["refund"]>[0]) {
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: amountCents,
    });
    return { refundId: refund.id };
  }

  verifyWebhook(rawBody: string, signature: string): WebhookEvent {
    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );

    const object = event.data.object as Record<string, unknown>;
    const paymentIntentId =
      event.type.startsWith("payment_intent.")
        ? (object.id as string)
        : ((object.payment_intent as string) ?? null);

    return {
      id: event.id,
      type: event.type,
      paymentIntentId,
      amountCents: typeof object.amount === "number" ? object.amount : null,
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

/**
 * In-memory adapter for tests. Tax is a flat 8% of the taxable base so
 * assertions stay predictable.
 */
export class FakePayments implements PaymentsAdapter {
  public intents = new Map<string, { amountCents: number; orderId: string }>();
  public refunds: { paymentIntentId: string; amountCents: number }[] = [];
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
    const id = paymentIntentId ?? `pi_fake_${++this.counter}`;
    this.intents.set(id, { amountCents, orderId });
    return { paymentIntentId: id, clientSecret: `${id}_secret` };
  }

  async refund({
    paymentIntentId,
    amountCents,
  }: Parameters<PaymentsAdapter["refund"]>[0]) {
    this.refunds.push({ paymentIntentId, amountCents });
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
import { eq, and, sql } from "drizzle-orm";
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
import { reserveStock, commitStock, RESERVATION_WINDOW_MS } from "@/lib/inventory";
import { redeemDiscount } from "@/lib/discounts";
import { getPayments } from "@/lib/payments";

export * from "./format";

export type OrderWithItems = Order & { items: OrderItem[] };

/**
 * Creates (or refreshes) a pending order and its PaymentIntent.
 *
 * The amount is computed here from database prices — never from anything the
 * client sent. Inventory is reserved in the same transaction that writes the
 * order, so a successful return means the stock is genuinely held.
 */
export async function createPendingOrder(args: {
  cartLines: QuoteLine[];
  email: string;
  shippingAddress: Address;
  billingAddress?: Address | null;
  discount?: AppliedDiscount | null;
  existingOrderId?: string | null;
}): Promise<{ order: Order; clientSecret: string }> {
  const { cartLines, email, shippingAddress, discount = null } = args;

  if (cartLines.length === 0) throw new Error("Cannot create an order from an empty cart");

  const payments = getPayments();
  const preTax = quote(cartLines, discount, 0);
  const tax = await payments.calculateTax({
    lines: cartLines,
    shippingCents: preTax.shippingCents,
    discountCents: preTax.discountCents,
    address: shippingAddress,
  });
  const final = quote(cartLines, discount, tax.taxCents);

  const order = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(orders)
      .values({
        email,
        status: "pending",
        discountCodeId: discount?.id ?? null,
        subtotalCents: final.subtotalCents,
        discountCents: final.discountCents,
        shippingCents: final.shippingCents,
        taxCents: final.taxCents,
        totalCents: final.totalCents,
        shippingAddress,
        billingAddress: args.billingAddress ?? shippingAddress,
        reservationExpiresAt: new Date(Date.now() + RESERVATION_WINDOW_MS),
      })
      .returning();

    await tx.insert(orderItems).values(
      cartLines.map((line) => ({
        orderId: created.id,
        productId: line.productId,
        name: line.name,
        unitPriceCents: line.unitPriceCents,
        quantity: line.quantity,
        totalCents: line.unitPriceCents * line.quantity,
      })),
    );

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

  const intent = await payments.createOrUpdateIntent({
    paymentIntentId: null,
    amountCents: final.totalCents,
    email,
    orderId: order.id,
    orderNumber: order.orderNumber,
  });

  await db
    .update(orders)
    .set({ stripePaymentIntentId: intent.paymentIntentId })
    .where(eq(orders.id, order.id));

  return { order, clientSecret: intent.clientSecret };
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
    if (order.discountCodeId) await redeemDiscount(tx, order.discountCodeId);

    return order;
  });
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

- [ ] **Step 6: Verify it type-checks and commit**

```bash
npx tsc --noEmit
git add src/lib/orders
git commit -m "feat: order creation and idempotent paid transition"
```

---

## Task 10: Transactional email

**Files:**
- Create: `src/lib/email/client.ts`, `src/lib/email/OrderConfirmation.tsx`, `src/lib/email/index.ts`

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
  Section,
  Text,
  Hr,
  Row,
  Column,
} from "@react-email/components";
import { formatCents } from "@/lib/money";
import { formatOrderNumber } from "@/lib/orders/format";
import type { OrderWithItems } from "@/lib/orders";
import type { Address } from "@/lib/db/schema";

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
  const address = order.shippingAddress as Address;

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

Create `src/lib/email/index.ts`:

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
      react: OrderConfirmation({ order }),
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
    <span
      aria-label="Coldsmoke"
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
import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "quiet";
  block?: boolean;
};

export function Button({
  variant = "outline",
  block = false,
  className,
  ...rest
}: Props) {
  const classes = [
    styles.base,
    variant === "primary" && styles.primary,
    variant === "quiet" && styles.quiet,
    block && styles.block,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <button className={classes} {...rest} />;
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
  border: 1px solid var(--line);
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

export function SiteHeader({ cartCount = 0 }: { cartCount?: number }) {
  return (
    <header className={styles.header}>
      <Link href="/" aria-label="Coldsmoke home">
        <Wordmark size={18} />
      </Link>

      <nav className={styles.nav} aria-label="Primary">
        <Link href="/shop">Shop</Link>
        <Link href="/the-scent">The Scent</Link>
        <Link href="/about">About</Link>
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
import { getOrCreateCartId, getCartLines } from "@/lib/cart";

export default async function StoreLayout({ children }: LayoutProps<"/">) {
  const cartId = await getOrCreateCartId();
  const lines = await getCartLines(cartId);
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <>
      <SiteHeader cartCount={count} />
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

Create `src/app/(store)/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOrCreateCartId, addItem, setQuantity } from "@/lib/cart";

export async function addToCartAction(formData: FormData): Promise<void> {
  const productId = String(formData.get("productId") ?? "");
  const quantity = Number(formData.get("quantity") ?? 1);

  if (!productId) throw new Error("Missing productId");

  const cartId = await getOrCreateCartId();
  await addItem(cartId, productId, Number.isFinite(quantity) ? quantity : 1);

  revalidatePath("/cart");
  redirect("/cart");
}

export async function setQuantityAction(formData: FormData): Promise<void> {
  const productId = String(formData.get("productId") ?? "");
  const quantity = Number(formData.get("quantity") ?? 0);

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
import Link from "next/link";
import { Wordmark } from "@/components/ui/Wordmark";
import { Button } from "@/components/ui/Button";
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
            <Link href="/shop">
              <Button variant="primary">Shop</Button>
            </Link>
            <Link href="/the-scent">
              <Button>The scent</Button>
            </Link>
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
import Link from "next/link";
import type { Metadata } from "next";
import { getActiveProducts } from "@/lib/catalog";
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

.visual {
  aspect-ratio: 3 / 4;
  background: linear-gradient(180deg, #17171b, #0a0a0c);
  border: 1px solid var(--line);
  display: grid;
  place-items: center;
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
  border: 1px solid var(--line);
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
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProductBySlug } from "@/lib/catalog";
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

  return (
    <div className={styles.page}>
      <div className={styles.visual}>
        <Wordmark size={24} />
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
            max={Math.max(product.available, 1)}
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
- Create: `src/app/(store)/cart/page.tsx` + `.module.css`, `src/app/(store)/cart/DiscountForm.tsx`
- Modify: `src/app/(store)/actions.ts`

**Interfaces:**
- Consumes: `getCartLines`, `quote`, `lookupDiscount`, `validateDiscount`, `discountFailureMessage`
- Produces: `applyDiscountAction(prev, formData): Promise<DiscountFormState>`; discount code persisted in the `cs_discount` cookie

- [ ] **Step 1: Add the discount Server Action**

Append to `src/app/(store)/actions.ts`:

```ts
import { cookies } from "next/headers";
import { getCartLines } from "@/lib/cart";
import { quote } from "@/lib/pricing/quote";
import {
  lookupDiscount,
  validateDiscount,
  discountFailureMessage,
} from "@/lib/discounts";

export const DISCOUNT_COOKIE = "cs_discount";

export type DiscountFormState = { error?: string; applied?: string };

export async function applyDiscountAction(
  _prev: DiscountFormState,
  formData: FormData,
): Promise<DiscountFormState> {
  const raw = String(formData.get("code") ?? "");
  const jar = await cookies();

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
    jar.delete(DISCOUNT_COOKIE);
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

/** Shared by the cart and checkout pages so both price identically. */
export async function getActiveDiscount() {
  const jar = await cookies();
  const stored = jar.get(DISCOUNT_COOKIE)?.value;
  if (!stored) return null;

  const cartId = await getOrCreateCartId();
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

export function DiscountForm({ applied }: { applied: string | null }) {
  const [state, action, pending] = useActionState<DiscountFormState, FormData>(
    applyDiscountAction,
    { applied: applied ?? undefined },
  );

  return (
    <form action={action} style={{ display: "grid", gap: "0.75rem" }}>
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

.qtyForm {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.qty {
  width: 4.5rem;
  padding: 0.5rem;
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--text-bright);
}

.summary {
  margin-top: var(--space-5);
  display: grid;
  gap: var(--space-5);
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
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
```

Create `src/app/(store)/cart/page.tsx`:

```tsx
import Link from "next/link";
import type { Metadata } from "next";
import { getOrCreateCartId, getCartLines } from "@/lib/cart";
import { quote, FREE_SHIPPING_THRESHOLD_CENTS } from "@/lib/pricing/quote";
import { formatCents } from "@/lib/money";
import { Button } from "@/components/ui/Button";
import { setQuantityAction, getActiveDiscount } from "../actions";
import { DiscountForm } from "./DiscountForm";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Cart" };

export default async function CartPage() {
  const cartId = await getOrCreateCartId();
  const lines = await getCartLines(cartId);
  const discount = await getActiveDiscount();
  const summary = quote(lines, discount);

  if (lines.length === 0) {
    return (
      <div className={styles.page}>
        <h1 className={styles.heading}>Cart</h1>
        <p className={styles.empty}>Your cart is empty.</p>
        <p style={{ marginTop: "1.5rem" }}>
          <Link href="/shop">
            <Button>Shop</Button>
          </Link>
        </p>
      </div>
    );
  }

  const remaining =
    FREE_SHIPPING_THRESHOLD_CENTS - (summary.subtotalCents - summary.discountCents);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Cart</h1>

      {lines.map((line) => (
        <div key={line.productId} className={styles.line}>
          <div>
            <div className={styles.lineName}>{line.name}</div>
            <div style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>
              {formatCents(line.unitPriceCents)} each
            </div>
          </div>

          <form action={setQuantityAction} className={styles.qtyForm}>
            <input type="hidden" name="productId" value={line.productId} />
            <label className="sr-only" htmlFor={`qty-${line.productId}`}>
              Quantity of {line.name}
            </label>
            <input
              id={`qty-${line.productId}`}
              className={styles.qty}
              type="number"
              name="quantity"
              defaultValue={line.quantity}
              min={0}
            />
            <Button type="submit" variant="quiet">
              Update
            </Button>
          </form>

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

          <Link href="/checkout" style={{ marginTop: "1rem" }}>
            <Button variant="primary" block>
              Checkout
            </Button>
          </Link>
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
import { getOrCreateCartId, getCartLines } from "@/lib/cart";
import { createPendingOrder } from "@/lib/orders";
import { OutOfStockError } from "@/lib/inventory";
import { getActiveDiscount } from "../actions";
import type { Address } from "@/lib/db/schema";

const addressSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  name: z.string().min(1, "Enter a name."),
  line1: z.string().min(1, "Enter a street address."),
  line2: z.string().optional(),
  city: z.string().min(1, "Enter a city."),
  state: z.string().length(2, "Use a two-letter state code."),
  postalCode: z.string().regex(/^\d{5}(-\d{4})?$/, "Enter a valid ZIP code."),
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
    return { status: "error", error: "Check the highlighted fields.", fieldErrors };
  }

  const { email, ...rest } = parsed.data;
  const shippingAddress: Address = { ...rest, country: "US" };

  const cartId = await getOrCreateCartId();
  const lines = await getCartLines(cartId);
  if (lines.length === 0) {
    return { status: "error", error: "Your cart is empty." };
  }

  const discount = await getActiveDiscount();

  try {
    const { order, clientSecret } = await createPendingOrder({
      cartLines: lines,
      email,
      shippingAddress,
      discount,
    });

    return {
      status: "ready",
      clientSecret,
      orderNumber: order.orderNumber,
      email: order.email,
      totalCents: order.totalCents,
    };
  } catch (error) {
    if (error instanceof OutOfStockError) {
      return {
        status: "error",
        error: "One of the items in your cart just sold out. Check your cart.",
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

const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!,
);

const appearance = {
  theme: "night" as const,
  variables: {
    colorPrimary: "#e4e7ec",
    colorBackground: "#17171b",
    colorText: "#b7bbc1",
    colorDanger: "#e0645c",
    borderRadius: "2px",
    fontFamily: "system-ui, sans-serif",
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

  const fieldErrors =
    state.status === "error" ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={action} style={{ display: "grid", gap: "1rem" }}>
      {state.status === "error" && !state.fieldErrors && (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {state.error}
        </p>
      )}

      <Field label="Email" name="email" type="email" required error={fieldErrors.email} />
      <Field label="Full name" name="name" required error={fieldErrors.name} />
      <Field label="Address" name="line1" required error={fieldErrors.line1} />
      <Field label="Apt, suite (optional)" name="line2" />
      <Field label="City" name="city" required error={fieldErrors.city} />
      <Field label="State" name="state" maxLength={2} required error={fieldErrors.state} />
      <Field label="ZIP" name="postalCode" required error={fieldErrors.postalCode} />

      <p style={{ color: "var(--text-faint)", fontSize: "0.8rem" }}>
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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    setError(null);

    const result = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/order/${orderNumber}?email=${encodeURIComponent(email)}`,
      },
      redirect: "if_required",
    });

    if (result.error) {
      setError(result.error.message ?? "Payment failed. Try another card.");
      setSubmitting(false);
      return;
    }

    window.location.href = `/order/${orderNumber}?email=${encodeURIComponent(email)}`;
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: "1.5rem" }}>
      <p style={{ color: "var(--text-bright)" }}>
        Total {formatCents(totalCents)}
      </p>

      <PaymentElement />

      {error && (
        <p role="alert" style={{ color: "var(--danger)" }}>
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
```

Create `src/app/(store)/checkout/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getOrCreateCartId, getCartLines } from "@/lib/cart";
import { CheckoutForm } from "./CheckoutForm";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage() {
  const cartId = await getOrCreateCartId();
  const lines = await getCartLines(cartId);
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
- Create: `vercel.json`

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
import { sendOrderConfirmation } from "@/lib/email";
import { releaseStock } from "@/lib/inventory";

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
        if (order) {
          const full = await findOrderById(order.id);
          if (full) await sendOrderConfirmation(full);
        }
        break;
      }

      case "payment_intent.payment_failed": {
        if (!event.paymentIntentId) break;
        await handleFailure(event.id, event.paymentIntentId);
        break;
      }

      default:
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    // Non-2xx makes Stripe retry, which the idempotency ledger makes safe.
    console.error("[webhook] handler failed", { type: event.type, error });
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
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

    // The order stays pending so the customer can retry with another card;
    // the reservation is held until its normal expiry.
    await tx
      .update(orders)
      .set({ status: "payment_failed" })
      .where(eq(orders.id, order.id));

    await releaseStock(tx, order.id);
  });
}
```

- [ ] **Step 2: Implement the reservation sweep route**

Create `src/app/api/cron/release-reservations/route.ts`:

```ts
import { NextResponse } from "next/server";
import { releaseExpiredReservations } from "@/lib/inventory";

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const released = await releaseExpiredReservations();
  return NextResponse.json({ released });
}
```

- [ ] **Step 3: Schedule the cron**

Create `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/release-reservations",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

- [ ] **Step 4: Test the webhook against the local server**

In one terminal: `npm run dev`
In another:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
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
git add src/app/api vercel.json
git commit -m "feat: Stripe webhook with idempotency and reservation sweep"
```

---

## Task 16: Order confirmation and guest order lookup

**Files:**
- Create: `src/app/(store)/order/[number]/page.tsx` + `.module.css`, `src/app/(store)/order/[number]/PendingNotice.tsx`, `src/app/(store)/order-lookup/page.tsx`, `src/app/(store)/order-lookup/actions.ts`

**Interfaces:**
- Consumes: `findOrderByNumber`, `parseOrderNumber`, `formatOrderNumber`, `formatCents`
- Produces: `lookupOrderAction(prev, formData): Promise<{ error?: string }>` (redirects on success)

- [ ] **Step 1: Build the pending-state client component**

Create `src/app/(store)/order/[number]/PendingNotice.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

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
    <p role="status" style={{ color: "var(--text-dim)" }}>
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
import { findOrderByNumber, parseOrderNumber, formatOrderNumber } from "@/lib/orders";
import { formatCents } from "@/lib/money";
import type { Address } from "@/lib/db/schema";
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
  searchParams,
}: PageProps<"/order/[number]">) {
  const { number } = await params;
  const { email } = await searchParams;

  const orderNumber = parseOrderNumber(number);
  const emailParam = typeof email === "string" ? email : null;

  // Guest orders are protected by requiring the email that placed them —
  // an order number alone must not expose an address.
  if (orderNumber === null || !emailParam) notFound();

  const order = await findOrderByNumber(orderNumber, emailParam);
  if (!order) notFound();

  const address = order.shippingAddress as Address;

  return (
    <div className={styles.page}>
      <p className={styles.status}>{STATUS_COPY[order.status] ?? order.status}</p>
      <h1 className={styles.number}>{formatOrderNumber(order.orderNumber)}</h1>

      {order.status === "pending" && <PendingNotice />}

      {order.status === "paid" && (
        <p style={{ marginTop: "var(--space-3)", color: "var(--text-dim)" }}>
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
            {order.shippingCents === 0 ? "Free" : formatCents(order.shippingCents)}
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

  redirect(`/order/${order.orderNumber}?email=${encodeURIComponent(email)}`);
}
```

- [ ] **Step 4: Build the lookup page**

Create `src/app/(store)/order-lookup/page.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { lookupOrderAction, type LookupState } from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

export default function OrderLookupPage() {
  const [state, action, pending] = useActionState<LookupState, FormData>(
    lookupOrderAction,
    {},
  );

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1
        style={{
          fontSize: "0.7rem",
          letterSpacing: "var(--track-mid)",
          textTransform: "uppercase",
          color: "var(--text-dim)",
          fontWeight: 400,
          marginBottom: "2.5rem",
        }}
      >
        Find an order
      </h1>

      <form action={action} style={{ display: "grid", gap: "1rem" }}>
        <Field label="Order number" name="orderNumber" placeholder="CS-1042" required />
        <Field label="Email" name="email" type="email" required />

        {state.error && (
          <p role="alert" style={{ color: "var(--danger)" }}>
            {state.error}
          </p>
        )}

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Looking" : "Find order"}
        </Button>
      </form>
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
    reuseExistingServer: true,
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

test("a guest can buy a bottle", async ({ page }) => {
  await page.goto("/shop");
  await expect(page.getByText("Coldsmoke Eau de Toilette")).toBeVisible();

  await page.getByText("Coldsmoke Eau de Toilette").click();
  await expect(page.getByRole("button", { name: "Add to cart" })).toBeVisible();
  await page.getByRole("button", { name: "Add to cart" }).click();

  await expect(page).toHaveURL(/\/cart/);
  await expect(page.getByText("$45.00").first()).toBeVisible();

  await page.getByRole("link", { name: "Checkout" }).click();
  await expect(page).toHaveURL(/\/checkout/);

  await page.getByLabel("Email").fill("buyer@example.com");
  await page.getByLabel("Full name").fill("Test Buyer");
  await page.getByLabel("Address").fill("1 Powder Lane");
  await page.getByLabel("City").fill("Bozeman");
  await page.getByLabel("State").fill("MT");
  await page.getByLabel("ZIP").fill("59715");

  await page.getByRole("button", { name: "Continue to payment" }).click();

  // The Payment Element renders in a Stripe-hosted iframe.
  const stripeFrame = page.frameLocator("iframe[title*='payment']").first();
  await stripeFrame.getByPlaceholder("1234 1234 1234 1234").fill("4242424242424242");
  await stripeFrame.getByPlaceholder("MM / YY").fill("12" + String(new Date().getFullYear() + 2).slice(-2));
  await stripeFrame.getByPlaceholder("CVC").fill("123");
  await stripeFrame.getByPlaceholder("12345").fill("59715");

  await page.getByRole("button", { name: /^Pay / }).click();

  await expect(page).toHaveURL(/\/order\/\d+/, { timeout: 30_000 });
  await expect(page.getByText(/CS-\d+/)).toBeVisible();
});
```

- [ ] **Step 6: Run the smoke test**

Ensure `stripe listen --forward-to localhost:3000/api/stripe/webhook` is running, then:

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
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Put the printed `whsec_...` in `.env` as `STRIPE_WEBHOOK_SECRET`.

## Deployment

Vercel + Neon. Set every variable from `.env.example` in the project settings,
add the production webhook endpoint in the Stripe dashboard pointing at
`/api/stripe/webhook`, and set `CRON_SECRET` to match the cron configured in
`vercel.json`.

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
