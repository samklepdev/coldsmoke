## Task 7: Cart identity and line management

**Files:**
- Create: `src/lib/cookies.ts`, `src/lib/cart/limits.ts`, `src/lib/cart/index.ts`, `src/lib/cart/cart.test.ts`

**Interfaces:**
- Consumes: `db`, `carts`, `cartItems`, `getProductsByIds`, `quote`
- Produces:
  - `CART_COOKIE = "cs_cart"`
  - `getOrCreateCartId(): Promise<string>` (reads/writes the cookie)
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
 * identified by a uuid in an httpOnly cookie; Plan 2 attaches userId on
 * sign-in and merges.
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

