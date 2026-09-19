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
