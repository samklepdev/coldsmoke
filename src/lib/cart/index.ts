import { cookies } from "next/headers";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { carts, cartItems } from "@/lib/db/schema";
import { getProductsByIds } from "@/lib/catalog";
import type { QuoteLine } from "@/lib/pricing/quote";

export const CART_COOKIE = "cs_cart";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/**
 * Per-line ceiling shared by the quantity inputs and the actions that write
 * them. cart_items.quantity is int4 with no CHECK constraint, so an unbounded
 * value would eventually overflow on the `quantity + n` upsert in addItem.
 */
export const MAX_LINE_QUANTITY = 99;

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
