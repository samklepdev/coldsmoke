import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
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
