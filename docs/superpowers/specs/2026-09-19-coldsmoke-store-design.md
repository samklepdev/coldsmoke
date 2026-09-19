# Coldsmoke — Store & Marketing Site Design

**Date:** 2026-09-19
**Status:** Approved design, pending implementation plan

A direct-to-consumer storefront and marketing site for Coldsmoke, a cool-spice-and-smoke
cologne. Custom checkout on Stripe, custom order and inventory management, full customer
accounts, and a full admin panel — all in one Next.js application.

Source material: `coldsmoke-brand-and-business-plan.md`, `coldsmoke-label-mockup.svg`.

---

## 1. Scope

### In scope

- Marketing site: home, scent story, about, FAQ, contact, legal pages.
- Storefront: shop, product detail, cart, custom checkout, order confirmation, order lookup.
- Two SKUs: Coldsmoke EDT 50 mL ($45) and a 2 mL sample ($6). These are seed values within
  the plan's $39–49 target band, editable in admin — no price is hardcoded in the
  application.
- Customer accounts: sign-up, sign-in, email verification, password reset, order history,
  saved addresses.
- Admin panel: orders and fulfillment, products and inventory, customers, discount codes.
- Payments via Stripe Elements embedded in the site's own checkout page.
- US-only shipping: $6 flat ground, free at $50+ subtotal. Sales tax via Stripe Tax.

### Out of scope

- International shipping. Fragrance is a flammable hazmat good; it ships ground-only
  domestically and requires dangerous-goods handling abroad.
- Wholesale portal, subscriptions, gift cards, product reviews, blog/journal.
- Phase 2/3 SKUs (100 mL, travel size, discovery set). The data model accommodates more
  products without migration, but none are built.

### Non-goals

This is not a general e-commerce platform. It serves one brand with a handful of SKUs.
Where a decision trades generality for clarity, take clarity.

---

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Framework | Next.js 16, App Router, React 19, TypeScript | Already scaffolded in repo |
| Styling | CSS Modules + design tokens | Matches existing scaffold; no Tailwind |
| Database | Postgres (Neon) + Drizzle ORM | Typed schema, real migrations, owns inventory |
| Payments | Stripe Elements (embedded) | Brand-consistent checkout under Coldsmoke's own UI |
| Tax | Stripe Tax | Avoids hand-maintaining nexus rules |
| Auth | Better Auth + Drizzle adapter | Self-hosted; users live beside orders; admin/roles plugin |
| Email | Resend + React Email | Templates are React components, inherit brand tokens |
| Hosting | Vercel + Neon | Serverless-compatible; rules out a SQLite file |
| Structure | Modular monolith with a `lib/` domain layer | One home for money logic; testable without a browser |

### Structural rationale

A direct App Router approach — Server Components querying Drizzle inline — would be
adequate for two SKUs. It was rejected because full accounts, fulfillment, and discount
codes mean pricing rules would otherwise be duplicated across the cart page, the
PaymentIntent creation path, and the webhook. Three call sites computing money
independently is three chances to charge the wrong amount.

A split storefront/API deployment was rejected as premature: there is no second front end
to serve, so it would add network latency, CORS, and duplicated types for no benefit.

---

## 3. Architecture

One Next.js application. Route handlers exist only where HTTP is mandatory — the Stripe
webhook and Better Auth's endpoints. Everything else is Server Components for reads and
Server Actions for writes.

```
src/
  app/
    (store)/          home, shop, product/[slug], cart, checkout, order/[number]
    (marketing)/      the-scent, about, faq, contact, legal/*
    (account)/        sign-in, sign-up, verify, reset, account/orders, account/addresses
    admin/            orders, products, customers, discounts   (role-gated layout)
    api/
      stripe/webhook/route.ts
      auth/[...all]/route.ts
      cron/release-reservations/route.ts
  lib/
    db/               drizzle client, schema, migrations
    catalog/          product reads
    cart/             cart identity, line items, guest→user merge
    pricing/          quote(): the single money calculation
    discounts/        code validation and redemption
    inventory/        reserve / release / commit
    orders/           creation, state transitions, lookup
    payments/         Stripe adapter behind an interface
    email/            Resend client and React Email templates
    auth/             Better Auth config, session and role guards
  components/         design primitives, then feature components
```

### Module rules

1. `lib/` modules never import from `app/`. Dependencies point inward.
2. Only `lib/payments` imports the Stripe SDK. Everything else depends on its interface,
   so tests substitute a fake adapter and run without network access.
3. `lib/pricing.quote()` is pure. Inputs: cart lines, optional discount, optional address.
   Outputs: subtotal, discount, shipping, tax, total. It is the only place money is
   computed. The cart page, PaymentIntent creation, and the webhook all call it.

### Module contracts

| Module | Responsibility | Key interface |
|---|---|---|
| `catalog` | Read products and images | `getActiveProducts()`, `getProductBySlug(slug)` |
| `cart` | Resolve cart identity, mutate lines | `getOrCreateCart()`, `addItem()`, `setQuantity()`, `mergeGuestCart(userId)` |
| `pricing` | Compute all money | `quote(lines, discount?, address?) → Quote` |
| `discounts` | Validate and redeem codes | `validate(code, subtotal) → Result`, `redeem(codeId, tx)` |
| `inventory` | Stock safety under concurrency | `reserve(items, tx)`, `commit(orderId, tx)`, `release(orderId, tx)` |
| `orders` | Order lifecycle | `createPending()`, `markPaid()`, `fulfill()`, `refund()`, `findByNumber()` |
| `payments` | Stripe boundary | `createOrUpdateIntent()`, `refund()`, `verifyWebhook()`, `calculateTax()` |
| `email` | Transactional sends | `sendOrderConfirmation()`, `sendShipped()`, `sendVerification()` |

---

## 4. Data model

All monetary values are **integer cents**. No floating-point money anywhere.

### Auth tables (managed by Better Auth)

`user`, `session`, `account`, `verification`. The `user` table carries a `role` column
(`customer` | `admin`) supplied by Better Auth's admin plugin.

### Store tables

**`products`** — `id`, `slug` (unique), `name`, `tagline`, `description`, `priceCents`,
`sku`, `active`, `sortOrder`, `createdAt`, `updatedAt`

**`product_images`** — `id`, `productId`, `url`, `alt`, `sortOrder`

**`inventory`** — `productId` (PK, FK), `onHand`, `reserved`, `updatedAt`
Separate from `products` so high-frequency stock writes do not contend with product edits.

**`carts`** — `id` (uuid), `userId` (nullable FK), `createdAt`, `updatedAt`
Guest carts are identified by a uuid in an httpOnly cookie. On sign-in, a guest cart
merges into the user's cart: quantities sum, capped at available stock.

**`cart_items`** — `id`, `cartId`, `productId`, `quantity`
Deliberately stores no price. Price resolves live from `products` at quote time, so a
week-old cart cannot lock in a stale price.

**`addresses`** — `id`, `userId`, `label`, `name`, `line1`, `line2`, `city`, `state`,
`postalCode`, `country`, `phone`, `isDefault`
Saved addresses for signed-in customers. Distinct from the address snapshot on an order.

**`discount_codes`** — `id`, `code` (unique, stored lowercase), `type`
(`percent` | `fixed`), `value`, `minSubtotalCents`, `maxRedemptions` (nullable),
`timesRedeemed`, `startsAt`, `endsAt`, `active`

**`orders`** — `id`, `orderNumber` (from a Postgres sequence, rendered `CS-1042`),
`userId` (nullable), `email`, `status`, `stripePaymentIntentId`, `discountCodeId`
(nullable), `subtotalCents`, `discountCents`, `shippingCents`, `taxCents`, `totalCents`,
`refundedCents`, `shippingAddress` (jsonb), `billingAddress` (jsonb), `carrier`,
`trackingNumber`, `createdAt`, `paidAt`, `fulfilledAt`, `cancelledAt`

**`order_items`** — `id`, `orderId`, `productId`, `name` (snapshot),
`unitPriceCents` (snapshot), `quantity`, `totalCents`

**`stripe_events`** — `id` (Stripe event id, PK), `type`, `processedAt`
Webhook idempotency ledger.

**`inventory_adjustments`** — `id`, `productId`, `delta`, `reason`, `adminUserId`,
`createdAt`
Audit trail for manual stock changes made in admin.

### Modeling choices

- **Orders snapshot everything.** Product name, unit price, and both addresses are copied
  onto the order rather than joined. Raising the price to $49 next spring must not
  retroactively change what a customer paid in January.
- **Addresses on orders are jsonb**, not FKs. An order records where it actually shipped;
  editing a saved address later must not rewrite shipping history.
- **Order status** is `pending → paid → fulfilled`, plus terminal `payment_failed`,
  `cancelled`, and `refunded`. Only the Stripe webhook may transition an order to `paid`.

---

## 5. Checkout and payment flow

### Sequence

1. Customer opens `/checkout`. Page collects email, shipping address, optional discount
   code, and a billing-same-as-shipping toggle.
2. Once the address is complete, a Server Action:
   - re-reads cart lines and current prices from the database,
   - validates any discount code,
   - calls Stripe Tax for the destination,
   - computes `pricing.quote()`,
   - **reserves inventory** in a transaction,
   - creates the order row as `pending`,
   - creates or updates a PaymentIntent for exactly that amount, with `orderId` in
     metadata,
   - returns `client_secret` plus the quote breakdown for display.
3. The Payment Element mounts with the `client_secret` and collects card, Apple Pay, or
   Link, themed to the Coldsmoke palette.
4. Client calls `confirmPayment({ redirect: 'if_required' })`.
5. Stripe fires `payment_intent.succeeded`. The webhook, in one transaction: records the
   event id, transitions the order to `paid`, commits inventory, increments the discount
   code's `timesRedeemed`, and enqueues the confirmation email.
6. The confirmation page reads the order by number. If the webhook has not yet landed, it
   shows a "confirming payment" state and polls briefly.

### Invariants

- **The server recomputes the amount** from the database immediately before creating or
  updating any PaymentIntent. A client-supplied total is never trusted. This is the single
  place a custom store most commonly bleeds money.
- **The webhook is the only writer of `paid`.** A client-side success callback is a hint,
  not proof — it can be lost to a closed tab or forged.
- **Webhook handling is idempotent.** Stripe retries on any non-2xx, and a replayed
  `succeeded` event that double-decrements stock is silent corruption. Every handler
  checks `stripe_events` first and returns 200 for an already-processed id.

### Inventory under concurrency

Stock correctness matters at a pilot batch of 50 units, where two buyers can genuinely
race for the last bottle.

- **Reserve** at PaymentIntent creation, inside a transaction:
  `UPDATE inventory SET reserved = reserved + :qty WHERE productId = :id AND onHand - reserved >= :qty`.
  Zero rows affected means out of stock — fail with a specific error before charging.
- **Expire** reservations after 15 minutes. Released by a lazy sweep on read, plus a Vercel
  cron hitting `/api/cron/release-reservations`. Without expiry, abandoned checkouts would
  permanently consume stock.
- **Commit** on `payment_intent.succeeded`: `onHand -= qty`, `reserved -= qty`.
- **Release** on payment failure, cancellation, or expiry: `reserved -= qty`.

### Shipping and tax

- Flat $6.00 ground shipping; free when post-discount subtotal is $50.00 or more.
- US addresses only. State and ZIP validated; the address form offers no other country,
  and the FAQ explains why.
- Stripe Tax computes sales tax from the shipping address. The result is stored in
  `orders.taxCents` for the record.

### Refunds

Initiated in admin, executed via `payments.refund()`, confirmed by the `charge.refunded`
webhook, which sets status and `refundedCents`. Restocking is an explicit checkbox, not
automatic — a returned bottle is not always resalable.

---

## 6. Authentication and admin

### Customers

Better Auth with email and password, email verification required before an account is
usable. Sessions stored in Postgres behind httpOnly, secure, SameSite=Lax cookies.

**Guest checkout remains available.** Requiring account creation at the moment of purchase
costs conversions, which matters most for an unknown brand. Guest orders record an email;
signing up later with that same address claims those orders into the account's history.

### Admin

`/admin` is gated in its layout by a server-side session check plus `role === 'admin'`.
Middleware performs a fast redirect for unauthenticated requests, but the layout check is
the actual security boundary — middleware alone is not one. The first admin is promoted by
a seed script run against the database.

| Section | Capabilities |
|---|---|
| Orders | List with search and status filter; detail view with items, customer, addresses, payment; mark fulfilled with carrier + tracking (sends shipping email); refund |
| Products | Edit name, tagline, description, price, images, active flag; adjust stock with a reason, written to `inventory_adjustments` |
| Customers | List with order count and lifetime spend; detail with order history; ban and impersonate via Better Auth's admin plugin |
| Discounts | Create and edit codes with type, value, minimum subtotal, expiry, usage cap; view redemption counts |

---

## 7. Pages and visual direction

### Page inventory

**Store** — Home, Shop, Product detail, Cart, Checkout, Order confirmation, Order lookup
(order number + email, for guests).
**Marketing** — The Scent (note pyramid as centerpiece), About, FAQ, Contact,
Shipping & Returns, Privacy Policy, Terms of Sale.
**Account** — Sign in, Sign up, Verify email, Reset password, My orders, My addresses.

### Visual direction

Derived from the label mockup. The site is **dark-first** by design, not a dark theme
applied to a light layout.

| Token | Value | Use |
|---|---|---|
| `--ground` | `#0A0A0C` | Page background |
| `--panel` | `#17171B` | Cards, elevated surfaces |
| `--line` | `#3E3F45` | Dividers, borders |
| `--text` | `#B7BBC1` | Body copy |
| `--text-dim` | `#8D9198` | Secondary text, labels |
| `--text-bright` | `#D2D5DA` | Headings, emphasis |
| Silver gradient | `#9AA0A8 → #E4E7EC → #9AA0A8` | Wordmark only |

Wide-tracked, light-weight display type for headings. Generous negative space. The ember
mark from the label is the only ornament, used sparingly. Copy follows the brand voice:
spare and dry, short sentences, no exclamation points, confidence through restraint.

Accessibility is a hard requirement, not a polish item: all text meets WCAG AA contrast
against its background, every interactive element has a visible focus state, and the
checkout form is fully keyboard-navigable with labeled inputs and errors announced to
screen readers.

One constraint worth naming: a fragrance site cannot demonstrate its product. The scent
pyramid, the materials story, and the packaging photography carry the entire persuasive
burden.

---

## 8. Error handling

| Failure | Behavior |
|---|---|
| Card declined | Inline message from the Payment Element; order stays `pending` and holds its reservation until expiry so the customer can retry |
| Out of stock at reserve | Specific message naming the product; cart quantity corrected to what is available; no charge attempted |
| Stripe Tax unavailable | **Block checkout with a retry prompt.** Charging a guessed tax amount is worse than a brief outage |
| Webhook handler throws | Return non-2xx so Stripe retries; idempotency ledger makes the retry safe |
| Email send fails | Logged and retried; never blocks or fails an order, because the payment already succeeded |
| Invalid discount code | Inline on cart and checkout; quote recomputes without it |
| Unexpected error | Route-group `error.tsx` boundaries, so a store failure does not take down marketing pages |

Server Actions return typed result objects (`{ ok: true, data }` / `{ ok: false, error }`)
rather than throwing across the network boundary, so the UI can render specific messages.

---

## 9. Testing

Testing effort concentrates where bugs cost money or corrupt data.

**Unit (Vitest)**
- `pricing.quote()` — table-driven cases: free-shipping threshold boundaries, percent vs
  fixed discounts, discount-before-shipping ordering, tax application, rounding.
- `discounts.validate()` — expiry, usage caps, minimum subtotal, inactive codes.
- `inventory` transitions — reserve, commit, release, expire.
- Order state machine — legal and illegal transitions.

**Integration (Vitest + real test Postgres)**
- **Concurrent reservation of the last unit** — two simultaneous reserves, exactly one
  succeeds. Unit tests cannot prove this.
- **Webhook replay idempotency** — the same event delivered twice decrements stock once.
- Guest cart merging into a user cart on sign-in.
- Admin role gating denies a `customer` role.

**Application**
- Fake `payments` adapter drives checkout flows without touching Stripe.
- Stripe CLI `trigger` exercises the real webhook path during development.

**End-to-end (Playwright)**
- One smoke path: browse → add to cart → checkout with a Stripe test card → confirmation
  page shows the order.

Marketing copy and static pages are not tested.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Client-manipulated totals | Server recomputes every amount before charging; never trust client money |
| Overselling a 50-unit batch | Transactional reservation with expiry; concurrency test as a gate |
| Duplicate webhook processing | `stripe_events` idempotency ledger |
| Building a store before the product is legal to sell | Out of scope for this design, but real: trademark clearance, LLC, insurance, and safety substantiation gate launch, not the site. Build behind a launch flag |
| Custom checkout raises PCI scope | Stripe Elements keeps card fields inside Stripe-hosted iframes, so card data never reaches our servers; never log or store card fields. Confirm the applicable SAQ level with Stripe before launch |
| Scope of full accounts + full admin | Largest driver of build time; sequence storefront and checkout first so the site can sell before admin is complete |

---

## 11. Open items

These do not block implementation but need answers before launch:

- Product photography. The site currently has only the label SVG; the design assumes
  bottle photography exists.
- Final copy for About, FAQ, and the scent story. Placeholders drawn from the business
  plan will be used until reviewed.
- Legal page contents (Privacy, Terms, Shipping & Returns) need real business details —
  the LLC name and address from the label spec are still placeholders.
- Brand typeface. The design assumes a wide-tracked light grotesque; the specific face is
  unchosen, and the label spec also lists this as a to-do.
