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
