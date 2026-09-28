# Product & Inventory Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin create and edit products, upload their images, and adjust stock with a reason — so running the shop stops requiring `railway ssh` and hand-written SQL.

**Architecture:** Stock moves by delta through `adjustStock`, which applies the change and writes the existing `inventory_adjustments` ledger in one transaction, with the below-zero guard in the `UPDATE`'s `WHERE`. Product writes live in `src/lib/products/admin.ts`. Images are stored as bytes in one new table and served by `/api/images/[id]`, so `product_images.url` keeps holding an ordinary URL.

**Tech Stack:** Next.js 16.3.5 (App Router, Server Components, Server Actions, Route Handlers), React 19.2, Drizzle ORM + drizzle-kit, Postgres, vitest 5 (node environment), zod 4.

**Spec:** `docs/superpowers/specs/2026-09-28-product-inventory-admin-design.md`

## Global Constraints

- **Stock changes by delta, never by an absolute value.** Applied as `on_hand = on_hand + n` inside the `UPDATE`. Two absolute writes silently overwrite each other; two deltas both land.
- **`on_hand` can never go below zero,** and the guard lives in the `UPDATE`'s `WHERE` (`on_hand + delta >= 0`), not in application code that reads first. Zero rows returned means refuse.
- **Every stock change writes an `inventory_adjustments` row in the same transaction.** Neither the movement nor its record can exist without the other.
- **`inventory.reserved` is never touched.** Adjustments are about physical units; reservations belong to live carts and orders.
- **A reason is required and non-empty.** The reason is the entire point of the ledger.
- **Non-integer deltas are refused, not rounded.** Postgres *rounds* on assignment to an `integer` column, so `1.5` would silently become 2.
- **Products are never deleted, only deactivated.** `order_items.product_id` references them with no `onDelete`.
- **`product_images.url` stays an ordinary URL.** Uploaded images resolve to `/api/images/<id>`; existing `/images/*.svg` paths and any future external URL keep working. Do not add a storage-specific column.
- **Every product image requires non-empty alt text.**
- **Server Actions repeat `requireAdminUser()`**, and the tests assert it explicitly. The session module is mocked wholesale, so without an assertion, deleting the check leaves every other test green.
- Verification commands: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run test:e2e`.
- DB-backed tests need Postgres: `npm run db:test:up` first.

---

### Task 1: Adjust stock by a delta

**Files:**
- Create: `src/lib/inventory/adjust.ts`
- Test: `src/lib/inventory/adjust.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class StockAdjustmentError extends Error`
  - `adjustStock(args: { productId: string; delta: number; reason: string; adminUserId: string }): Promise<void>`

This is the task the whole feature rests on. `src/lib/inventory/index.ts` already contains `reserveStock`, `commitStock`, `releaseStock` and `restockOrderItems` — read them first. `restockOrderItems` is the closest model: the guard in the `WHERE`, `.returning()` checked for length, a ledger row written in the same transaction.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/inventory/adjust.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { products, inventory, inventoryAdjustments } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
let productId: string;

// adjust.ts imports `db` at module scope, so without this the suite would
// write to the dev database. The dynamic import below keeps the module load
// after the mock is registered.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

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
  await ctx.db.insert(inventory).values({ productId, onHand: 10, reserved: 3 });
});

const { adjustStock, StockAdjustmentError } = await import("./adjust");

async function stock() {
  const [row] = await ctx.db
    .select()
    .from(inventory)
    .where(eq(inventory.productId, productId));
  return row;
}

async function ledger() {
  return ctx.db.select().from(inventoryAdjustments);
}

describe("adjustStock", () => {
  it("raises stock and records why", async () => {
    await adjustStock({
      productId,
      delta: 12,
      reason: "received from supplier",
      adminUserId: "admin_1",
    });

    expect((await stock()).onHand).toBe(22);

    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0].delta).toBe(12);
    expect(rows[0].reason).toBe("received from supplier");
    expect(rows[0].adminUserId).toBe("admin_1");
  });

  it("lowers stock", async () => {
    await adjustStock({
      productId,
      delta: -4,
      reason: "damaged",
      adminUserId: "admin_1",
    });

    expect((await stock()).onHand).toBe(6);
    expect((await ledger())[0].delta).toBe(-4);
  });

  it("refuses to drive stock below zero, and records nothing", async () => {
    await expect(
      adjustStock({
        productId,
        delta: -11,
        reason: "recount",
        adminUserId: "admin_1",
      }),
    ).rejects.toThrow(StockAdjustmentError);

    // The movement and its record move together or not at all.
    expect((await stock()).onHand).toBe(10);
    expect(await ledger()).toHaveLength(0);
  });

  it("allows a delta that lands exactly on zero", async () => {
    await adjustStock({
      productId,
      delta: -10,
      reason: "sold out at market",
      adminUserId: "admin_1",
    });

    expect((await stock()).onHand).toBe(0);
  });

  it("leaves reserved untouched", async () => {
    // Seeded non-zero on purpose: a fixture starting at 0 cannot tell
    // "untouched" from "clamped to zero".
    await adjustStock({
      productId,
      delta: 5,
      reason: "received",
      adminUserId: "admin_1",
    });

    expect((await stock()).reserved).toBe(3);
  });

  it("refuses a zero delta", async () => {
    await expect(
      adjustStock({ productId, delta: 0, reason: "nothing", adminUserId: "admin_1" }),
    ).rejects.toThrow(StockAdjustmentError);
  });

  it("refuses a non-integer delta", async () => {
    // Postgres ROUNDS on assignment to an integer column, so 1.5 would
    // silently become 2 in both the stock and the ledger.
    await expect(
      adjustStock({ productId, delta: 1.5, reason: "half", adminUserId: "admin_1" }),
    ).rejects.toThrow(StockAdjustmentError);

    expect((await stock()).onHand).toBe(10);
  });

  it("refuses an empty reason", async () => {
    await expect(
      adjustStock({ productId, delta: 1, reason: "   ", adminUserId: "admin_1" }),
    ).rejects.toThrow(StockAdjustmentError);
  });

  it("refuses a product with no inventory row", async () => {
    const [other] = await ctx.db
      .insert(products)
      .values({
        slug: "no-stock",
        name: "No Stock",
        description: "x",
        priceCents: 100,
        sku: "T-2",
      })
      .returning();

    await expect(
      adjustStock({
        productId: other.id,
        delta: 1,
        reason: "received",
        adminUserId: "admin_1",
      }),
    ).rejects.toThrow(StockAdjustmentError);

    expect(await ledger()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/inventory/adjust.test.ts`
Expected: FAIL — cannot resolve `./adjust`.

- [ ] **Step 3: Implement it**

Create `src/lib/inventory/adjust.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { inventory, inventoryAdjustments } from "@/lib/db/schema";

export class StockAdjustmentError extends Error {
  constructor(reason: string) {
    super(`Cannot adjust stock: ${reason}`);
    this.name = "StockAdjustmentError";
  }
}

/**
 * Moves a product's stock by a delta and records why.
 *
 * A delta rather than an absolute value, deliberately. "Set stock to 40" is a
 * read-modify-write: two admins counting at once silently overwrite each
 * other, and a count taken five minutes ago clobbers a sale made since. Two
 * deltas both land. It also makes the ledger honest -- `delta` is what
 * actually happened, where an absolute set would have to reverse-engineer one.
 *
 * The below-zero guard is in the WHERE clause, like reserveStock's, so the
 * check and the write are one atomic statement with no gap to lose. Negative
 * stock is not a state the storefront can represent.
 *
 * `reserved` is untouched: adjustments are about physical units, while
 * reservations belong to live carts and orders.
 */
export async function adjustStock(args: {
  productId: string;
  delta: number;
  reason: string;
  adminUserId: string;
}): Promise<void> {
  if (!Number.isInteger(args.delta)) {
    // Postgres rounds on assignment to an integer column, so a fractional
    // delta would silently become a different number in both the stock and
    // the ledger row that claims to explain it.
    throw new StockAdjustmentError("stock moves in whole units");
  }
  if (args.delta === 0) {
    throw new StockAdjustmentError("a change of zero is not a change");
  }

  const reason = args.reason.trim();
  if (!reason) {
    throw new StockAdjustmentError("say why the stock changed");
  }

  await db.transaction(async (tx) => {
    const moved = await tx
      .update(inventory)
      .set({
        onHand: sql`${inventory.onHand} + ${args.delta}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventory.productId, args.productId),
          sql`${inventory.onHand} + ${args.delta} >= 0`,
        ),
      )
      .returning({ productId: inventory.productId });

    if (moved.length === 0) {
      throw new StockAdjustmentError(
        "that would leave stock below zero, or the product has no stock record",
      );
    }

    await tx.insert(inventoryAdjustments).values({
      productId: args.productId,
      delta: args.delta,
      reason,
      adminUserId: args.adminUserId,
    });
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/inventory/adjust.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Mutation-test the below-zero guard**

This is the guarantee the task exists for, so demonstrate it rather than assume it.

Temporarily delete this line from the `.where(and(...))`:

```ts
          sql`${inventory.onHand} + ${args.delta} >= 0`,
```

Run: `npx vitest run src/lib/inventory/adjust.test.ts`
Expected: FAIL — "refuses to drive stock below zero, and records nothing".

**Then restore the line** and re-run to confirm green. Report both results. If the test still passed with the guard removed, it is not protecting the invariant and must be fixed before moving on.

- [ ] **Step 6: Verify types and lint, then commit**

Run: `npx tsc --noEmit && npm run lint`

```bash
git add src/lib/inventory/adjust.ts src/lib/inventory/adjust.test.ts
git commit -m "feat: adjust stock by a delta, with a reason

Second writer to the inventory_adjustments ledger, which has existed unused
since Plan 1. The below-zero guard is in the UPDATE's WHERE and is verified
load-bearing: removing it fails the refusal test."
```

---

### Task 2: Product writes

**Files:**
- Create: `src/lib/products/admin.ts`
- Test: `src/lib/products/admin.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `class ProductInputError extends Error`
  - `type ProductInput`
  - `createProduct(input: ProductInput): Promise<Product>`
  - `updateProduct(id: string, input: ProductInput): Promise<Product>`
  - `setProductActive(id: string, active: boolean): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add a new file at `src/lib/products/admin.test.ts` using the same harness as `src/lib/inventory/adjust.test.ts` (Task 1, Step 1) — the `vi.mock` of `@/lib/db/client`, `beforeAll`/`afterAll`/`beforeEach` with `ctx.truncate()`, and a dynamic import — but with no seeded product. Then:

```ts
const { createProduct, updateProduct, setProductActive, ProductInputError } =
  await import("./admin");
const { getActiveProducts } = await import("@/lib/catalog");

const VALID = {
  slug: "coldsmoke-edt-50ml",
  name: "Coldsmoke Eau de Toilette",
  tagline: "Cold air. Dark spice.",
  description: "A crisp icy opening.",
  priceCents: 4500,
  sku: "CS-1",
  active: true,
  sortOrder: 0,
};

describe("createProduct", () => {
  it("persists every field", async () => {
    const created = await createProduct(VALID);

    expect(created.slug).toBe(VALID.slug);
    expect(created.name).toBe(VALID.name);
    expect(created.tagline).toBe(VALID.tagline);
    expect(created.description).toBe(VALID.description);
    expect(created.priceCents).toBe(4500);
    expect(created.sku).toBe("CS-1");
    expect(created.active).toBe(true);
    expect(created.sortOrder).toBe(0);
  });

  it("reports a duplicate slug as a friendly error and inserts nothing", async () => {
    await createProduct(VALID);

    await expect(createProduct(VALID)).rejects.toThrow(ProductInputError);

    expect(await ctx.db.select().from(products)).toHaveLength(1);
  });

  it("refuses a price below zero and a blank name", async () => {
    await expect(
      createProduct({ ...VALID, priceCents: -1 }),
    ).rejects.toThrow(ProductInputError);
    await expect(
      createProduct({ ...VALID, slug: "other", sku: "X", name: "  " }),
    ).rejects.toThrow(ProductInputError);
  });

  it("refuses a slug that is not URL-safe", async () => {
    // The slug is the product's public URL; spaces and slashes would break it.
    await expect(
      createProduct({ ...VALID, slug: "not a slug" }),
    ).rejects.toThrow(ProductInputError);
  });
});

describe("updateProduct", () => {
  it("changes the fields given", async () => {
    const created = await createProduct(VALID);

    const updated = await updateProduct(created.id, {
      ...VALID,
      name: "Coldsmoke EDT",
      priceCents: 5000,
    });

    expect(updated.name).toBe("Coldsmoke EDT");
    expect(updated.priceCents).toBe(5000);
    expect(updated.id).toBe(created.id);
  });
});

describe("setProductActive", () => {
  it("hides a deactivated product from the storefront", async () => {
    const created = await createProduct(VALID);
    expect(await getActiveProducts()).toHaveLength(1);

    await setProductActive(created.id, false);

    // Asserted against the real storefront query, not just the column, so a
    // change to how the catalogue filters cannot silently break this.
    expect(await getActiveProducts()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/products/admin.test.ts`
Expected: FAIL — cannot resolve `./admin`.

- [ ] **Step 3: Implement it**

Create `src/lib/products/admin.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { products, type Product } from "@/lib/db/schema";

export class ProductInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductInputError";
  }
}

export type ProductInput = {
  slug: string;
  name: string;
  tagline: string | null;
  description: string;
  priceCents: number;
  sku: string;
  active: boolean;
  sortOrder: number;
};

function isDuplicate(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

function validate(input: ProductInput): ProductInput {
  const slug = input.slug.trim().toLowerCase();
  const name = input.name.trim();
  const sku = input.sku.trim();

  if (!slug) throw new ProductInputError("Give the product a slug.");
  if (!/^[a-z0-9-]+$/.test(slug)) {
    // The slug is the product's public URL.
    throw new ProductInputError(
      "Slugs can use lowercase letters, numbers and hyphens only.",
    );
  }
  if (!name) throw new ProductInputError("Give the product a name.");
  if (!sku) throw new ProductInputError("Give the product a SKU.");
  if (!input.description.trim()) {
    throw new ProductInputError("Give the product a description.");
  }
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new ProductInputError("Enter a price of zero or more.");
  }
  if (!Number.isInteger(input.sortOrder)) {
    throw new ProductInputError("Sort order must be a whole number.");
  }

  return {
    ...input,
    slug,
    name,
    sku,
    tagline: input.tagline?.trim() || null,
    description: input.description.trim(),
  };
}

export async function createProduct(input: ProductInput): Promise<Product> {
  const clean = validate(input);

  try {
    const [row] = await db.insert(products).values(clean).returning();
    return row;
  } catch (error) {
    // From the unique index rather than a pre-read: a read-then-insert can
    // lose the race, the constraint cannot.
    if (isDuplicate(error)) {
      throw new ProductInputError("A product with that slug already exists.");
    }
    throw error;
  }
}

export async function updateProduct(
  id: string,
  input: ProductInput,
): Promise<Product> {
  const clean = validate(input);

  try {
    const [row] = await db
      .update(products)
      .set({ ...clean, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();

    if (!row) throw new ProductInputError("No such product.");
    return row;
  } catch (error) {
    if (isDuplicate(error)) {
      throw new ProductInputError("A product with that slug already exists.");
    }
    throw error;
  }
}

/**
 * Retires or restores a product. Never deletes: order_items.product_id
 * references it with no onDelete, so a delete would break historical orders.
 */
export async function setProductActive(
  id: string,
  active: boolean,
): Promise<void> {
  await db
    .update(products)
    .set({ active, updatedAt: new Date() })
    .where(eq(products.id, id));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/products/admin.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify types and lint, then commit**

Run: `npx tsc --noEmit && npm run lint`

```bash
git add src/lib/products/admin.ts src/lib/products/admin.test.ts
git commit -m "feat: create, edit and retire products

Deactivating rather than deleting: order_items references products forever."
```

---

### Task 3: Image storage

**Files:**
- Modify: `src/lib/db/schema.ts` (one new table)
- Create: `drizzle/0009_*.sql` (generated — do not hand-write)
- Create: `src/lib/products/images.ts`
- Test: `src/lib/products/images.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `productImageFiles` table on the Drizzle schema
  - `class ProductImageError extends Error`
  - `storeProductImage(args: { productId: string; bytes: Buffer; contentType: string; alt: string }): Promise<void>`
  - `getProductImageFile(id: string): Promise<{ bytes: Buffer; contentType: string } | null>`

- [ ] **Step 1: Add the table**

Append to `src/lib/db/schema.ts`:

```ts
/**
 * Bytes for uploaded product images.
 *
 * In the database rather than object storage, deliberately: no new vendor, no
 * credentials, survives a Railway redeploy, and works at any replica count.
 * The trade is binaries in Postgres and no CDN, which is nothing for a few
 * product shots and wrong at hundreds -- product_images.url holds an ordinary
 * URL, so moving to object storage later is a backfill, not a redesign.
 */
export const productImageFiles = pgTable("product_image_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  bytes: customBytea("bytes").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

Drizzle has no built-in `bytea` helper for postgres-js, so define one above the table, next to the other helpers at the top of the file:

```ts
/** Drizzle ships no bytea column type; this is the documented custom-type shape. */
const customBytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});
```

and add `customType` to the existing `drizzle-orm/pg-core` import.

- [ ] **Step 2: Generate and read the migration**

Run: `npm run db:generate`
Then: `cat drizzle/0009_*.sql`

Expected: a single `CREATE TABLE "product_image_files"` with a `bytea` column, and nothing else. **Stop and report if it contains anything else** — a `DROP`, a rename, or a change to another table means the schema file drifted from the database.

- [ ] **Step 3: Apply it**

Run: `npm run db:test:up && npm run db:migrate`
Expected: applies cleanly.

- [ ] **Step 4: Write the failing tests**

Add a new file at `src/lib/products/images.test.ts`, using the same harness as `src/lib/products/admin.test.ts` plus a product seeded in `beforeEach`:

```ts
const { storeProductImage, getProductImageFile, ProductImageError } =
  await import("./images");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("storeProductImage", () => {
  it("stores the bytes and links a product image whose url resolves to them", async () => {
    await storeProductImage({
      productId,
      bytes: PNG,
      contentType: "image/png",
      alt: "The bottle on a dark background",
    });

    const [link] = await ctx.db.select().from(productImages);
    expect(link.alt).toBe("The bottle on a dark background");
    expect(link.url).toMatch(/^\/api\/images\/[0-9a-f-]{36}$/);

    const id = link.url.split("/").pop()!;
    const file = await getProductImageFile(id);
    expect(file).not.toBeNull();
    expect(file!.contentType).toBe("image/png");
    expect(Buffer.compare(file!.bytes, PNG)).toBe(0);
  });

  it("refuses an unsupported content type", async () => {
    await expect(
      storeProductImage({
        productId,
        bytes: PNG,
        contentType: "application/pdf",
        alt: "x",
      }),
    ).rejects.toThrow(ProductImageError);

    expect(await ctx.db.select().from(productImages)).toHaveLength(0);
  });

  it("refuses a file over the size limit", async () => {
    await expect(
      storeProductImage({
        productId,
        bytes: Buffer.alloc(2 * 1024 * 1024 + 1),
        contentType: "image/png",
        alt: "x",
      }),
    ).rejects.toThrow(ProductImageError);
  });

  it("refuses empty alt text", async () => {
    // Every product image is content the storefront renders; an empty alt is
    // a silent accessibility regression.
    await expect(
      storeProductImage({ productId, bytes: PNG, contentType: "image/png", alt: "  " }),
    ).rejects.toThrow(ProductImageError);
  });
});

describe("getProductImageFile", () => {
  it("returns null for an unknown id", async () => {
    expect(
      await getProductImageFile("00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run src/lib/products/images.test.ts`
Expected: FAIL — cannot resolve `./images`.

- [ ] **Step 6: Implement it**

Create `src/lib/products/images.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { productImageFiles, productImages } from "@/lib/db/schema";

export class ProductImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductImageError";
  }
}

const ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);

/** A guard against filling the database by accident, not a security boundary. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Stores an uploaded image and links it to a product.
 *
 * Both writes happen in one transaction: a file row nothing references is
 * litter, and a product_images row pointing at bytes that were never stored
 * renders as a broken image.
 */
export async function storeProductImage(args: {
  productId: string;
  bytes: Buffer;
  contentType: string;
  alt: string;
}): Promise<void> {
  if (!ALLOWED.has(args.contentType)) {
    throw new ProductImageError("Upload a JPEG, PNG, WebP or SVG.");
  }
  if (args.bytes.byteLength === 0) {
    throw new ProductImageError("That file is empty.");
  }
  if (args.bytes.byteLength > MAX_BYTES) {
    throw new ProductImageError("Images must be 2 MB or smaller.");
  }

  const alt = args.alt.trim();
  if (!alt) {
    throw new ProductImageError("Describe the image for screen readers.");
  }

  await db.transaction(async (tx) => {
    const [file] = await tx
      .insert(productImageFiles)
      .values({
        bytes: args.bytes,
        contentType: args.contentType,
        byteSize: args.bytes.byteLength,
      })
      .returning({ id: productImageFiles.id });

    await tx.insert(productImages).values({
      productId: args.productId,
      // An ordinary URL, so the storefront needs no knowledge of where the
      // bytes live and the existing /images/*.svg rows keep working.
      url: `/api/images/${file.id}`,
      alt,
    });
  });
}

export async function getProductImageFile(
  id: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const [row] = await db
    .select()
    .from(productImageFiles)
    .where(eq(productImageFiles.id, id))
    .limit(1);

  return row ? { bytes: row.bytes, contentType: row.contentType } : null;
}
```

- [ ] **Step 7: Run the tests, verify types and lint, then commit**

Run: `npx vitest run src/lib/products/images.test.ts && npx tsc --noEmit && npm run lint`

```bash
git add src/lib/db/schema.ts drizzle src/lib/products/images.ts src/lib/products/images.test.ts
git commit -m "feat: store product images in Postgres behind a URL

Unfashionable and right at this size: no new vendor, no credentials, survives
a redeploy, works at any replica count. product_images.url stays an ordinary
URL, so moving to object storage later is a backfill rather than a redesign."
```

---

### Task 4: Serve the images

**Files:**
- Create: `src/app/api/images/[id]/route.ts`
- Test: `src/app/api/images/[id]/route.test.ts`

**Interfaces:**
- Consumes: `getProductImageFile` from Task 3.
- Produces: `GET /api/images/[id]`.

Read `src/app/api/health/route.ts` first for this repo's route-handler style.

- [ ] **Step 1: Write the failing test**

Add a new file at `src/app/api/images/[id]/route.test.ts` using the same harness as `src/lib/products/images.test.ts`:

```ts
const { GET } = await import("./route");
const { storeProductImage } = await import("@/lib/products/images");

async function storedImageId() {
  await storeProductImage({
    productId,
    bytes: PNG,
    contentType: "image/png",
    alt: "The bottle",
  });
  const [link] = await ctx.db.select().from(productImages);
  return link.url.split("/").pop()!;
}

describe("GET /api/images/[id]", () => {
  it("serves the bytes with the stored content type and a long cache", async () => {
    const id = await storedImageId();

    const response = await GET(new Request("http://test/api/images/x"), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), PNG)).toBe(0);
  });

  it("404s for an unknown id", async () => {
    const response = await GET(new Request("http://test/api/images/x"), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });

    expect(response.status).toBe(404);
  });

  it("404s for an id that is not a uuid, rather than erroring", async () => {
    // A uuid column rejects malformed input with a Postgres 22P02, which would
    // otherwise escape as a 500.
    const response = await GET(new Request("http://test/api/images/x"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });

    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run "src/app/api/images/[id]/route.test.ts"`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement it**

Create `src/app/api/images/[id]/route.ts`:

```ts
import { z } from "zod";
import { getProductImageFile } from "@/lib/products/images";

/**
 * Serves an uploaded product image.
 *
 * Unauthenticated on purpose: these are product photographs on a public shop.
 * The id is opaque, so nothing is enumerable beyond images already on the
 * storefront.
 *
 * Cached hard and immutably. A row's bytes never change -- replacing an image
 * creates a new row with a new id -- so a cached URL can never go stale.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // A malformed id would reach a uuid column and raise a Postgres 22P02,
  // escaping as a 500. It is simply not found.
  if (!z.uuid().safeParse(id).success) {
    return new Response("Not found", { status: 404 });
  }

  const file = await getProductImageFile(id);
  if (!file) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
```

- [ ] **Step 4: Run the test, verify types and lint, then commit**

Run: `npx vitest run "src/app/api/images/[id]/route.test.ts" && npx tsc --noEmit && npm run lint`

```bash
git add "src/app/api/images/[id]"
git commit -m "feat: serve uploaded product images"
```

---

### Task 5: Server actions

**Files:**
- Create: `src/app/(admin)/admin/products/actions.ts`
- Test: `src/app/(admin)/admin/products/actions.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `saveProductAction`, `adjustStockAction`, `uploadImageAction`, `type ProductAdminState`.

Read `src/app/(admin)/admin/orders/[id]/actions.ts` for the pattern: `requireAdminUser()` first, zod parsing, `revalidatePath`, catching the domain error and rethrowing the rest.

- [ ] **Step 1: Write the failing tests**

Add a new file at `src/app/(admin)/admin/products/actions.test.ts` with the same harness as Task 1's tests, plus the `requireAdminUser` mock from `src/app/(admin)/admin/orders/[id]/actions.test.ts` — as a `vi.fn`, so the gate can be asserted. Cover:

```ts
describe("saveProductAction", () => {
  it("creates a product when given no id", async () => {
    const state = await saveProductAction({ status: "idle" }, form({
      slug: "new-edt",
      name: "New EDT",
      tagline: "",
      description: "Something",
      price: "45.00",
      sku: "N-1",
      active: "on",
      sortOrder: "0",
    }));

    expect(state.status).toBe("saved");
    const [row] = await ctx.db.select().from(products);
    expect(row.priceCents).toBe(4500);
  });

  it("reports a duplicate slug instead of throwing", async () => {
    await createProduct(VALID);

    const state = await saveProductAction({ status: "idle" }, form({ ...FIELDS, slug: VALID.slug }));

    expect(state.status).toBe("error");
  });
});

describe("adjustStockAction", () => {
  it("applies the delta", async () => {
    const state = await adjustStockAction({ status: "idle" }, form({
      productId,
      delta: "5",
      reason: "received",
    }));

    expect(state.status).toBe("saved");
    const [row] = await ctx.db.select().from(inventory).where(eq(inventory.productId, productId));
    expect(row.onHand).toBe(15);
  });

  it("reports a refusal instead of throwing", async () => {
    const state = await adjustStockAction({ status: "idle" }, form({
      productId,
      delta: "-99",
      reason: "recount",
    }));

    expect(state.status).toBe("error");
  });

  it("rejects rather than reporting a friendly error when something unexpected fails", async () => {
    const boom = vi
      .spyOn(adjustModule, "adjustStock")
      .mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      adjustStockAction({ status: "idle" }, form({ productId, delta: "1", reason: "x" })),
    ).rejects.toThrow("connection reset");

    boom.mockRestore();
  });
});

describe("the admin gate", () => {
  // The session module is mocked wholesale, so without these assertions
  // deleting requireAdminUser() leaves every other test green.
  it("is called by saveProductAction", async () => {
    requireAdminUser.mockClear();
    await saveProductAction({ status: "idle" }, form(FIELDS));
    expect(requireAdminUser).toHaveBeenCalledTimes(1);
  });

  it("is called by adjustStockAction", async () => {
    requireAdminUser.mockClear();
    await adjustStockAction({ status: "idle" }, form({ productId, delta: "1", reason: "x" }));
    expect(requireAdminUser).toHaveBeenCalledTimes(1);
  });

  it("is called by uploadImageAction", async () => {
    requireAdminUser.mockClear();
    await uploadImageAction({ status: "idle" }, imageForm());
    expect(requireAdminUser).toHaveBeenCalledTimes(1);
  });
});
```

Write `form()` and `imageForm()` helpers in the file; `imageForm()` builds a `FormData` containing a `File` made from the PNG bytes used in Task 3.

- [ ] **Step 2: Run to verify failure, then implement**

Create `src/app/(admin)/admin/products/actions.ts`:

```ts
"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdminUser } from "@/lib/auth/session";
import {
  createProduct,
  updateProduct,
  ProductInputError,
  type ProductInput,
} from "@/lib/products/admin";
import { storeProductImage, ProductImageError } from "@/lib/products/images";
import { adjustStock, StockAdjustmentError } from "@/lib/inventory/adjust";

export type ProductAdminState =
  | { status: "idle" }
  | { status: "saved" }
  | { status: "error"; error: string };

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** Prices are entered in dollars and stored in cents, like every money column. */
function dollarsToCents(raw: string): number | null {
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function readProductInput(formData: FormData): ProductInput | null {
  const priceCents = dollarsToCents(text(formData, "price"));
  if (priceCents === null) return null;

  const sortOrder = Number(text(formData, "sortOrder").trim() || "0");
  if (!Number.isInteger(sortOrder)) return null;

  return {
    slug: text(formData, "slug"),
    name: text(formData, "name"),
    tagline: text(formData, "tagline") || null,
    description: text(formData, "description"),
    priceCents,
    sku: text(formData, "sku"),
    active: formData.get("active") !== null,
    sortOrder,
  };
}

export async function saveProductAction(
  _prev: ProductAdminState,
  formData: FormData,
): Promise<ProductAdminState> {
  await requireAdminUser();

  const input = readProductInput(formData);
  if (!input) {
    return { status: "error", error: "Check the price and sort order." };
  }

  const id = formData.get("id");
  const existing = typeof id === "string" && id ? z.uuid().safeParse(id) : null;

  try {
    const saved = existing?.success
      ? await updateProduct(existing.data, input)
      : await createProduct(input);

    revalidatePath("/admin/products");
    revalidatePath(`/admin/products/${saved.id}`);
    // These edits change what customers see.
    revalidatePath("/shop");
    revalidatePath(`/product/${saved.slug}`);

    return { status: "saved" };
  } catch (error) {
    if (error instanceof ProductInputError) {
      return { status: "error", error: error.message };
    }
    throw error;
  }
}

export async function adjustStockAction(
  _prev: ProductAdminState,
  formData: FormData,
): Promise<ProductAdminState> {
  const admin = await requireAdminUser();

  const productId = z.uuid().safeParse(formData.get("productId"));
  if (!productId.success) {
    return { status: "error", error: "Unknown product." };
  }

  const delta = Number(text(formData, "delta").trim());
  if (!Number.isFinite(delta)) {
    return { status: "error", error: "Enter a whole number of units." };
  }

  try {
    await adjustStock({
      productId: productId.data,
      delta,
      reason: text(formData, "reason"),
      adminUserId: admin.id,
    });
  } catch (error) {
    if (error instanceof StockAdjustmentError) {
      return { status: "error", error: error.message };
    }
    throw error;
  }

  revalidatePath(`/admin/products/${productId.data}`);
  revalidatePath("/admin/products");
  revalidatePath("/shop");

  return { status: "saved" };
}

export async function uploadImageAction(
  _prev: ProductAdminState,
  formData: FormData,
): Promise<ProductAdminState> {
  await requireAdminUser();

  const productId = z.uuid().safeParse(formData.get("productId"));
  if (!productId.success) {
    return { status: "error", error: "Unknown product." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", error: "Choose an image." };
  }

  try {
    await storeProductImage({
      productId: productId.data,
      bytes: Buffer.from(await file.arrayBuffer()),
      contentType: file.type,
      alt: text(formData, "alt"),
    });
  } catch (error) {
    if (error instanceof ProductImageError) {
      return { status: "error", error: error.message };
    }
    throw error;
  }

  revalidatePath(`/admin/products/${productId.data}`);
  revalidatePath("/shop");

  return { status: "saved" };
}
```

- [ ] **Step 3: Prove the admin gate assertions are load-bearing**

Delete `await requireAdminUser();` from `adjustStockAction`.

Run: `npx vitest run "src/app/(admin)/admin/products/actions.test.ts"`
Expected: FAIL — "is called by adjustStockAction" only.

Restore it, confirm green, and report both results.

- [ ] **Step 4: Verify types and lint, then commit**

Run: `npx tsc --noEmit && npm run lint`

```bash
git add "src/app/(admin)/admin/products/actions.ts" "src/app/(admin)/admin/products/actions.test.ts"
git commit -m "feat: admin actions for products, stock and image upload"
```

---

### Task 6: The product pages

**Files:**
- Create: `src/app/(admin)/admin/products/page.tsx`
- Create: `src/app/(admin)/admin/products/new/page.tsx`
- Create: `src/app/(admin)/admin/products/[id]/page.tsx`
- Create: `src/app/(admin)/admin/products/ProductForms.tsx`
- Create: `src/app/(admin)/admin/products/products.module.css`
- Modify: `src/app/(admin)/admin/layout.tsx` (add the nav link)

**Interfaces:**
- Consumes: `saveProductAction`, `adjustStockAction`, `uploadImageAction`, `ProductAdminState` from Task 5.
- Produces: nothing.

- [ ] **Step 1: Add the nav link**

In `src/app/(admin)/admin/layout.tsx`, the nav currently holds one link. Replace that `<nav>` block with:

```tsx
        <nav className={styles.nav} aria-label="Admin">
          <Link href="/admin/orders">Orders</Link>
          <Link href="/admin/products">Products</Link>
        </nav>
```

- [ ] **Step 2: Build the forms**

Three forms, three separate `useActionState` calls. A `formAction` on a button inside another form would pass `FormData` as `prevState` and crash, because `useActionState` actions take `(prevState, formData)` — this repo has hit that exact bug before.

Create `src/app/(admin)/admin/products/ProductForms.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import {
  saveProductAction,
  adjustStockAction,
  uploadImageAction,
  type ProductAdminState,
} from "./actions";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import styles from "./products.module.css";

export type ProductDefaults = {
  id: string | null;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  priceCents: number;
  sku: string;
  active: boolean;
  sortOrder: number;
};

export const BLANK_PRODUCT: ProductDefaults = {
  id: null,
  slug: "",
  name: "",
  tagline: "",
  description: "",
  priceCents: 0,
  sku: "",
  active: true,
  sortOrder: 0,
};

/**
 * Create or edit. The absence of an id is what makes it a create, so the
 * hidden field is omitted rather than empty.
 */
export function ProductDetailsForm({ product }: { product: ProductDefaults }) {
  const [state, action, pending] = useActionState<ProductAdminState, FormData>(
    saveProductAction,
    { status: "idle" },
  );

  return (
    <form action={action} className={styles.form}>
      {product.id && <input type="hidden" name="id" value={product.id} />}

      <Field label="Name" name="name" defaultValue={product.name} required />

      <Field
        label="Slug"
        name="slug"
        defaultValue={product.slug}
        required
        autoComplete="off"
      />
      <p className={styles.hint}>
        The slug is this product&apos;s public URL. Changing it breaks every
        existing link to the product.
      </p>

      <Field label="Tagline" name="tagline" defaultValue={product.tagline} />

      <label className={styles.textareaLabel}>
        Description
        <textarea
          name="description"
          defaultValue={product.description}
          rows={5}
          required
        />
      </label>

      <Field
        label="Price ($)"
        name="price"
        type="number"
        min={0}
        step={0.01}
        defaultValue={(product.priceCents / 100).toFixed(2)}
        required
      />

      <Field label="SKU" name="sku" defaultValue={product.sku} required />

      <Field
        label="Sort order"
        name="sortOrder"
        type="number"
        step={1}
        defaultValue={product.sortOrder}
      />

      <label className={styles.checkboxLabel}>
        <input type="checkbox" name="active" defaultChecked={product.active} />
        Active — shown in the shop
      </label>

      {state.status === "error" && <p role="alert">{state.error}</p>}
      {state.status === "saved" && <p role="status">Saved.</p>}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving" : "Save product"}
      </Button>
    </form>
  );
}

export function AdjustStockForm({
  productId,
  onHand,
}: {
  productId: string;
  onHand: number;
}) {
  const [state, action, pending] = useActionState<ProductAdminState, FormData>(
    adjustStockAction,
    { status: "idle" },
  );

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="productId" value={productId} />

      <p>
        On hand: <strong>{onHand}</strong>
      </p>

      <Field
        label="Change by (+ or −)"
        name="delta"
        type="number"
        step={1}
        required
        aria-describedby="delta-hint"
      />
      <p id="delta-hint" className={styles.hint}>
        A change, not a total. Enter −3 to record three damaged bottles, not the
        number you counted on the shelf.
      </p>

      <Field label="Reason" name="reason" required autoComplete="off" />

      {state.status === "error" && <p role="alert">{state.error}</p>}
      {state.status === "saved" && <p role="status">Stock updated.</p>}

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Saving" : "Adjust stock"}
      </Button>
    </form>
  );
}

export function UploadImageForm({ productId }: { productId: string }) {
  const [state, action, pending] = useActionState<ProductAdminState, FormData>(
    uploadImageAction,
    { status: "idle" },
  );

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="productId" value={productId} />

      <label className={styles.fileLabel}>
        Image file
        <input
          type="file"
          name="file"
          accept="image/jpeg,image/png,image/webp,image/svg+xml"
          required
        />
      </label>

      <Field
        label="Alt text"
        name="alt"
        required
        aria-describedby="alt-hint"
      />
      <p id="alt-hint" className={styles.hint}>
        Describe the image for someone who cannot see it. It is required.
      </p>

      {state.status === "error" && <p role="alert">{state.error}</p>}
      {state.status === "saved" && <p role="status">Image uploaded.</p>}

      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Uploading" : "Upload image"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 3: Build the list page**

Create `src/app/(admin)/admin/products/page.tsx`:

```tsx
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { products, inventory } from "@/lib/db/schema";
import { formatCents } from "@/lib/money";
import styles from "./products.module.css";

export const metadata = { title: "Products" };

export default async function AdminProductsPage() {
  // Inactive products are included on purpose: this is the only page that can
  // bring one back, so hiding them here would strand them.
  //
  // Left join rather than a query per row, and it also surfaces a product with
  // no inventory record at all -- which cannot be adjusted until one exists.
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      priceCents: products.priceCents,
      active: products.active,
      onHand: inventory.onHand,
    })
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .orderBy(asc(products.sortOrder), asc(products.name));

  return (
    <section>
      <div className={styles.headingRow}>
        <h1 className={styles.heading}>Products</h1>
        <Link href="/admin/products/new">Add product</Link>
      </div>

      {rows.length === 0 ? (
        <p>No products yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>SKU</th>
              <th className={styles.right}>Price</th>
              <th className={styles.right}>On hand</th>
              <th>Shown in shop</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/admin/products/${row.id}`}>{row.name}</Link>
                </td>
                <td>{row.sku}</td>
                <td className={styles.right}>{formatCents(row.priceCents)}</td>
                <td className={styles.right}>
                  {row.onHand ?? <span title="No stock record">—</span>}
                </td>
                <td>{row.active ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Build the create page**

Create `src/app/(admin)/admin/products/new/page.tsx`:

```tsx
import { BLANK_PRODUCT, ProductDetailsForm } from "../ProductForms";
import styles from "../products.module.css";

export const metadata = { title: "New product" };

/**
 * The same form as the editor's Details section, with no id — which is what
 * makes saveProductAction create rather than update.
 *
 * Images and stock are deliberately absent: both need a product id, so they
 * appear once it has been saved.
 */
export default function NewProductPage() {
  return (
    <section>
      <h1 className={styles.heading}>New product</h1>
      <ProductDetailsForm product={BLANK_PRODUCT} />
    </section>
  );
}
```

- [ ] **Step 5: Build the editor**

Create `src/app/(admin)/admin/products/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  products,
  inventory,
  productImages,
  inventoryAdjustments,
} from "@/lib/db/schema";
import {
  ProductDetailsForm,
  AdjustStockForm,
  UploadImageForm,
} from "../ProductForms";
import styles from "../products.module.css";

export const metadata = { title: "Edit product" };

export default async function AdminProductPage({
  params,
}: PageProps<"/admin/products/[id]">) {
  const { id } = await params;

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, id))
    .limit(1);

  if (!product) notFound();

  const [stock] = await db
    .select()
    .from(inventory)
    .where(eq(inventory.productId, product.id))
    .limit(1);

  const images = await db
    .select()
    .from(productImages)
    .where(eq(productImages.productId, product.id))
    .orderBy(productImages.sortOrder);

  // The page that changes stock is also the page that explains it.
  const history = await db
    .select()
    .from(inventoryAdjustments)
    .where(eq(inventoryAdjustments.productId, product.id))
    .orderBy(desc(inventoryAdjustments.createdAt))
    .limit(20);

  return (
    <section>
      <h1 className={styles.heading}>{product.name}</h1>

      <h2 className={styles.subheading}>Details</h2>
      <ProductDetailsForm
        product={{
          id: product.id,
          slug: product.slug,
          name: product.name,
          tagline: product.tagline ?? "",
          description: product.description,
          priceCents: product.priceCents,
          sku: product.sku,
          active: product.active,
          sortOrder: product.sortOrder,
        }}
      />

      <h2 className={styles.subheading}>Images</h2>
      {images.length === 0 ? (
        <p>No images yet. The shop falls back to placeholder artwork.</p>
      ) : (
        <ul className={styles.images}>
          {images.map((image) => (
            <li key={image.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt={image.alt} width={120} />
              <span>{image.alt}</span>
            </li>
          ))}
        </ul>
      )}
      <UploadImageForm productId={product.id} />

      <h2 className={styles.subheading}>Stock</h2>
      {stock ? (
        <AdjustStockForm productId={product.id} onHand={stock.onHand} />
      ) : (
        <p role="alert">
          This product has no stock record, so it cannot be adjusted or sold.
        </p>
      )}

      {history.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>When</th>
              <th className={styles.right}>Change</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {history.map((row) => (
              <tr key={row.id}>
                <td>{row.createdAt.toISOString().slice(0, 10)}</td>
                <td className={styles.right}>
                  {row.delta > 0 ? `+${row.delta}` : row.delta}
                </td>
                <td>{row.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

Note the `img` rather than `next/image`: these are admin thumbnails served from `/api/images/[id]`, and routing them through the image optimiser buys nothing at 120px while adding a transform on every admin page view.

- [ ] **Step 6: Add the stylesheet**

Create `src/app/(admin)/admin/products/products.module.css`:

```css
.headingRow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.heading {
  font-size: 1.5rem;
}

.subheading {
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.6;
  margin: 2.5rem 0 0.75rem;
}

.form {
  display: grid;
  gap: 0.75rem;
  max-width: 32rem;
}

.hint {
  font-size: 0.8125rem;
  opacity: 0.6;
  margin-top: -0.35rem;
}

.textareaLabel,
.checkboxLabel,
.fileLabel {
  display: grid;
  gap: 0.35rem;
  font-size: 0.875rem;
}

.checkboxLabel {
  grid-auto-flow: column;
  justify-content: start;
  align-items: center;
  gap: 0.5rem;
}

.images {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  list-style: none;
  padding: 0;
  margin: 0 0 1rem;
}

.images li {
  display: grid;
  gap: 0.35rem;
  font-size: 0.8125rem;
  max-width: 120px;
}

.table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 1rem;
}

.table th,
.table td {
  text-align: left;
  padding: 0.75rem 0;
  border-bottom: 1px solid rgb(255 255 255 / 0.1);
}

.right {
  text-align: right;
}
```

- [ ] **Step 7: Verify types and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: both clean.

If `PageProps<"/admin/products/[id]">` does not resolve, this project generates those types from the route tree — run `npm run dev` once to regenerate, or match the param typing used by `src/app/(admin)/admin/orders/[id]/page.tsx`.

- [ ] **Step 8: Check it in the running app**

This step is the controller's, not the implementer's — it needs an authenticated admin session. **Skip it and say so in your report.**

- [ ] **Step 9: Commit**

```bash
git add "src/app/(admin)/admin/products" "src/app/(admin)/admin/layout.tsx"
git commit -m "feat: manage products, images and stock from the admin panel"
```

---

### Task 7: Register the plan and verify

**Files:**
- Modify: `src/test/plan-drift.test.ts` (the `PLANS` array)

**Interfaces:**
- Consumes: every file from Tasks 1-6.
- Produces: nothing.

- [ ] **Step 1: Register this plan**

Append to `src/test/plan-drift.test.ts`:

```ts
  "docs/superpowers/plans/2026-09-28-product-inventory-admin.md",
```

- [ ] **Step 2: Run the guard and reconcile**

Run: `npx vitest run src/test/plan-drift.test.ts`

Expected: it may FAIL, naming this plan's `Create` blocks. For each, decide which side is right: if the shipped code is correct, update this plan's block to match. **Do not weaken the test and do not add `plan-drift: partial` markers.** Re-run until green.

- [ ] **Step 3: Full verification**

Run: `npm test && npx tsc --noEmit && npm run lint && npm run test:e2e`
Expected: all green.

The payment e2e self-skips unless a `stripe listen` is forwarding. **A skip means it did not run.** To exercise it:

```bash
STRIPE_API_KEY="$STRIPE_SECRET_KEY" stripe listen \
  --events payment_intent.succeeded,payment_intent.payment_failed,charge.refunded \
  --forward-to localhost:3000/api/stripe/webhook
```

Pass the key via `STRIPE_API_KEY` in the environment rather than `--api-key`, so it stays out of `ps` — the e2e's skip guard reads `ps -ax -o args=`. CLI 1.51 requires `--events`.

Report which of the two happened.

- [ ] **Step 4: Commit**

```bash
git add src/test/plan-drift.test.ts docs/superpowers/plans
git commit -m "docs: bring the product and inventory admin plan under the drift guard"
```

---

## Success criteria

- An admin can add a product, upload an image for it, and see it on the storefront, without touching SQL or committing a file.
- An admin can correct a stock count and later find out why it changed.
- Stock can never be driven negative, under any sequence of adjustments — and removing the guard from the `UPDATE` fails a test.
- A stock movement and its ledger row always exist together or not at all.
- Deactivating a product removes it from the storefront while leaving historical orders intact.
- Deleting `requireAdminUser()` from any of the three actions fails a test.
- `npm test`, `npx tsc --noEmit`, `npm run lint` and `npm run test:e2e` are green, with this plan registered in the drift guard.
