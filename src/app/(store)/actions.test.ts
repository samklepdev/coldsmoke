import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { products, carts, cartItems } from "@/lib/db/schema";

/**
 * The quantity arriving from a form is an arbitrary string. addItem and
 * setQuantity throw on anything that is not an integer in range, and a throw
 * inside a Server Action reaches the user as an unhandled error, so the actions
 * coerce first. These tests pin that coercion.
 */

let cookieCartId: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "cs_cart" && cookieCartId ? { value: cookieCartId } : undefined,
    set: () => {},
    delete: () => {},
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// The real redirect() signals by throwing; mirror that so the action's control
// flow matches production instead of falling through past the redirect.
class RedirectSignal extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { addToCartAction, setQuantityAction } = await import("./actions");

let bottleId: string;

/** Runs the action and swallows the redirect it ends with. */
async function addToCart(form: FormData): Promise<void> {
  try {
    await addToCartAction(form);
  } catch (error) {
    if (!(error instanceof RedirectSignal)) throw error;
  }
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function storedQuantity(): Promise<number | undefined> {
  const [row] = await ctx.db
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, cookieCartId!));
  return row?.quantity;
}

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
  cookieCartId = cart.id;
});

describe("addToCartAction", () => {
  it("adds the requested quantity when it is a valid integer", async () => {
    await addToCart(form({ productId: bottleId, quantity: "3" }));
    expect(await storedQuantity()).toBe(3);
  });

  it("falls back to 1 when the quantity field is submitted empty", async () => {
    // Number("") === 0, which addItem rejects.
    await addToCart(form({ productId: bottleId, quantity: "" }));
    expect(await storedQuantity()).toBe(1);
  });

  it("falls back to 1 for a fractional quantity", async () => {
    await addToCart(form({ productId: bottleId, quantity: "2.5" }));
    expect(await storedQuantity()).toBe(1);
  });

  it("falls back to 1 for a negative quantity", async () => {
    await addToCart(form({ productId: bottleId, quantity: "-3" }));
    expect(await storedQuantity()).toBe(1);
  });

  it("falls back to 1 for a non-numeric quantity", async () => {
    await addToCart(form({ productId: bottleId, quantity: "abc" }));
    expect(await storedQuantity()).toBe(1);
  });

  it("falls back to 1 above the per-line cap, so the upsert cannot overflow", async () => {
    await addToCart(form({ productId: bottleId, quantity: "2000000000" }));
    expect(await storedQuantity()).toBe(1);
  });

  it("still rejects a missing productId", async () => {
    await expect(addToCart(form({ quantity: "1" }))).rejects.toThrow(
      "Missing productId",
    );
  });
});

describe("setQuantityAction", () => {
  beforeEach(async () => {
    await addToCart(form({ productId: bottleId, quantity: "2" }));
  });

  it("sets a valid quantity", async () => {
    await setQuantityAction(form({ productId: bottleId, quantity: "5" }));
    expect(await storedQuantity()).toBe(5);
  });

  it("removes the line at zero", async () => {
    await setQuantityAction(form({ productId: bottleId, quantity: "0" }));
    expect(await storedQuantity()).toBeUndefined();
  });

  it("leaves the line untouched when the quantity is malformed", async () => {
    // The dangerous shape: a bad parse must not read as "remove this line".
    await setQuantityAction(form({ productId: bottleId, quantity: "" }));
    expect(await storedQuantity()).toBe(2);
  });

  it("leaves the line untouched above the per-line cap", async () => {
    await setQuantityAction(form({ productId: bottleId, quantity: "500" }));
    expect(await storedQuantity()).toBe(2);
  });
});
