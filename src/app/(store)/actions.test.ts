import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { products, carts, cartItems, discountCodes } from "@/lib/db/schema";

/**
 * The quantity arriving from a form is an arbitrary string. addItem and
 * setQuantity throw on anything that is not an integer in range, and a throw
 * inside a Server Action reaches the user as an unhandled error, so the actions
 * coerce first. These tests pin that coercion.
 */

/**
 * A stand-in cookie jar. The discount action's whole contract is expressed in
 * cookie writes, so asserting against a real store is the point — a no-op mock
 * would let a missing `set` or `delete` pass.
 */
const jar = new Map<string, string>();
let cookieCartId: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === "cs_cart") {
        return cookieCartId ? { value: cookieCartId } : undefined;
      }
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
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

const {
  addToCartAction,
  setQuantityAction,
  applyDiscountAction,
  getActiveDiscount,
} = await import("./actions");

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
  jar.clear();

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

describe("applyDiscountAction", () => {
  beforeEach(async () => {
    // One bottle: a $45.00 subtotal.
    await addToCart(form({ productId: bottleId, quantity: "1" }));

    await ctx.db.insert(discountCodes).values([
      { code: "smoke10", type: "percent", value: 10 },
      // Needs a $60.00 order; the seeded cart is below it.
      { code: "bigspend", type: "fixed", value: 500, minSubtotalCents: 6000 },
      { code: "retired", type: "percent", value: 10, active: false },
    ]);
  });

  it("stores a valid code in the discount cookie", async () => {
    const state = await applyDiscountAction({}, form({ code: "smoke10" }));

    expect(state).toEqual({ applied: "smoke10" });
    expect(jar.get("cs_discount")).toBe("smoke10");
  });

  it("accepts a code in any case, storing the canonical lowercase form", async () => {
    const state = await applyDiscountAction({}, form({ code: "  SmOkE10 " }));

    expect(state).toEqual({ applied: "smoke10" });
    expect(jar.get("cs_discount")).toBe("smoke10");
  });

  it("reports an unknown code without storing it", async () => {
    const state = await applyDiscountAction({}, form({ code: "nosuchcode" }));

    expect(state.error).toBe("That code isn't valid.");
    expect(jar.has("cs_discount")).toBe(false);
  });

  it("explains the minimum when the cart is below it", async () => {
    const state = await applyDiscountAction({}, form({ code: "bigspend" }));

    expect(state.error).toBe("That code needs an order of $60.00 or more.");
    expect(jar.has("cs_discount")).toBe(false);
  });

  it("rejects an inactive code", async () => {
    const state = await applyDiscountAction({}, form({ code: "retired" }));

    expect(state.error).toBe("That code is no longer active.");
    expect(jar.has("cs_discount")).toBe(false);
  });

  it("clears the applied code when a rejected one is submitted after it", async () => {
    // The trap: the cookie is dropped, so the page must not keep showing the
    // old discount in its totals.
    await applyDiscountAction({}, form({ code: "smoke10" }));
    expect(jar.get("cs_discount")).toBe("smoke10");

    const state = await applyDiscountAction({}, form({ code: "nosuchcode" }));

    expect(state.error).toBe("That code isn't valid.");
    expect(jar.has("cs_discount")).toBe(false);
    expect(await getActiveDiscount()).toBeNull();
  });

  it("clears the applied code on an empty submission", async () => {
    await applyDiscountAction({}, form({ code: "smoke10" }));

    const state = await applyDiscountAction({}, form({ code: "   " }));

    expect(state).toEqual({});
    expect(jar.has("cs_discount")).toBe(false);
  });
});

describe("getActiveDiscount", () => {
  beforeEach(async () => {
    await addToCart(form({ productId: bottleId, quantity: "2" }));
    await ctx.db
      .insert(discountCodes)
      .values({ code: "bigspend", type: "fixed", value: 500, minSubtotalCents: 6000 });
  });

  it("returns nothing when no code is applied", async () => {
    expect(await getActiveDiscount()).toBeNull();
  });

  it("returns the applied discount while the cart still qualifies", async () => {
    // Two bottles: $90.00, over the $60.00 minimum.
    await applyDiscountAction({}, form({ code: "bigspend" }));

    expect(await getActiveDiscount()).toMatchObject({
      code: "bigspend",
      type: "fixed",
      value: 500,
    });
  });

  it("stops applying once the cart drops below the code's minimum", async () => {
    await applyDiscountAction({}, form({ code: "bigspend" }));
    expect(await getActiveDiscount()).not.toBeNull();

    // Down to one bottle: $45.00, under the minimum. The cookie is untouched,
    // so re-validation on read is the only thing preventing a discount the
    // order no longer qualifies for.
    await setQuantityAction(form({ productId: bottleId, quantity: "1" }));

    expect(jar.get("cs_discount")).toBe("bigspend");
    expect(await getActiveDiscount()).toBeNull();
  });
});
