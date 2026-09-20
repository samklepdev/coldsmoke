import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { carts, cartItems, products, inventory } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

let guestCartId: string | null = null;
const cookieSet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "cs_cart" && guestCartId ? { value: guestCartId } : undefined,
    set: (name: string, value: string, options: unknown) =>
      cookieSet(name, value, options),
  }),
}));

const { mergeGuestCart } = await import("./merge");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

let productId: string;

beforeEach(async () => {
  await ctx.truncate();
  cookieSet.mockClear();

  const [product] = await ctx.db
    .insert(products)
    .values({
      slug: "coldsmoke-edt",
      name: "Coldsmoke Eau de Toilette",
      description: "Cold air. Dark spice.",
      priceCents: 4500,
      sku: "CS-EDT-50",
    })
    .returning({ id: products.id });
  productId = product.id;

  await ctx.db.insert(inventory).values({ productId, onHand: 10, reserved: 0 });
});

async function makeCart(userId: string | null, quantity?: number) {
  const [cart] = await ctx.db
    .insert(carts)
    .values({ userId })
    .returning({ id: carts.id });
  if (quantity !== undefined) {
    await ctx.db.insert(cartItems).values({ cartId: cart.id, productId, quantity });
  }
  return cart.id;
}

async function quantityIn(cartId: string): Promise<number | undefined> {
  const rows = await ctx.db
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId));
  return rows[0]?.quantity;
}

describe("mergeGuestCart", () => {
  it("adopts the guest cart when the customer has none", async () => {
    guestCartId = await makeCart(null, 2);

    await mergeGuestCart("user_1");

    const [cart] = await ctx.db
      .select()
      .from(carts)
      .where(eq(carts.id, guestCartId!));
    expect(cart.userId).toBe("user_1");
  });

  it("sums quantities when both carts hold the same product", async () => {
    const userCartId = await makeCart("user_1", 1);
    guestCartId = await makeCart(null, 2);

    await mergeGuestCart("user_1");

    expect(await quantityIn(userCartId)).toBe(3);
  });

  it("caps the sum at what is actually in stock", async () => {
    await ctx.db
      .update(inventory)
      .set({ onHand: 4 })
      .where(eq(inventory.productId, productId));
    const userCartId = await makeCart("user_1", 3);
    guestCartId = await makeCart(null, 3);

    await mergeGuestCart("user_1");

    // 3 + 3 = 6, but only 4 exist. Carrying 6 forward would just move the
    // failure to checkout, where it costs the customer their place.
    expect(await quantityIn(userCartId)).toBe(4);
  });

  it("caps the sum at the per-line ceiling", async () => {
    await ctx.db
      .update(inventory)
      .set({ onHand: 500 })
      .where(eq(inventory.productId, productId));
    const userCartId = await makeCart("user_1", 60);
    guestCartId = await makeCart(null, 60);

    await mergeGuestCart("user_1");

    expect(await quantityIn(userCartId)).toBe(99);
  });

  it("empties the guest cart it merged from", async () => {
    await makeCart("user_1", 1);
    guestCartId = await makeCart(null, 2);

    await mergeGuestCart("user_1");

    expect(await quantityIn(guestCartId!)).toBeUndefined();
  });

  it("points the cookie at the customer's cart", async () => {
    const userCartId = await makeCart("user_1", 1);
    guestCartId = await makeCart(null, 2);

    await mergeGuestCart("user_1");

    expect(cookieSet).toHaveBeenCalledWith(
      "cs_cart",
      userCartId,
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it("does nothing when there is no guest cart", async () => {
    guestCartId = null;
    const userCartId = await makeCart("user_1", 1);

    await mergeGuestCart("user_1");

    expect(await quantityIn(userCartId)).toBe(1);
  });

  it("is a no-op when the guest cart is already the customer's", async () => {
    guestCartId = await makeCart("user_1", 2);

    await mergeGuestCart("user_1");

    expect(await quantityIn(guestCartId!)).toBe(2);
  });
});
