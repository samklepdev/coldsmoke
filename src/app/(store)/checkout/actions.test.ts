import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import {
  products,
  inventory,
  carts,
  cartItems,
  orders,
} from "@/lib/db/schema";
import { FakePayments } from "@/lib/payments/fake";

const fake = new FakePayments();
vi.mock("@/lib/payments", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments")>(
    "@/lib/payments",
  );
  return { ...actual, getPayments: () => fake };
});

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
  // The action reads the session to attach a signed-in buyer's userId to the
  // order. Empty headers mean no session, which is the guest path these tests
  // exercise -- guest checkout has to keep working.
  headers: async () => new Headers(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { startCheckoutAction } = await import("./actions");

let bottleId: string;

const VALID = {
  email: "buyer@example.com",
  name: "Test Buyer",
  line1: "1 Powder Lane",
  line2: "",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
};

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({ ...VALID, ...overrides })) {
    data.append(key, value);
  }
  return data;
}

async function start(overrides?: Record<string, string>) {
  return startCheckoutAction({ status: "idle" }, form(overrides));
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
  fake.intents.clear();
  fake.refunds.length = 0;

  const [bottle] = await ctx.db
    .insert(products)
    .values({
      slug: "coldsmoke-edt-50ml",
      name: "Coldsmoke Eau de Toilette",
      description: "d",
      priceCents: 4500,
      sku: "CS-1",
    })
    .returning();
  bottleId = bottle.id;
  await ctx.db.insert(inventory).values({ productId: bottleId, onHand: 5 });

  const [cart] = await ctx.db.insert(carts).values({}).returning();
  cookieCartId = cart.id;
  await ctx.db
    .insert(cartItems)
    .values({ cartId: cart.id, productId: bottleId, quantity: 1 });
});

describe("startCheckoutAction — address validation", () => {
  it("reports a field error per invalid field without touching the cart", async () => {
    const state = await start({ email: "nope", state: "texas", postalCode: "1" });

    expect(state).toMatchObject({
      status: "error",
      error: "Check the highlighted fields.",
    });
    if (state.status !== "error") throw new Error("expected an error state");
    expect(state.fieldErrors).toEqual({
      email: "Enter a valid email address.",
      state: "Use a two-letter state code.",
      postalCode: "Enter a valid ZIP code.",
    });
    expect(await ctx.db.select().from(orders)).toHaveLength(0);
  });

  it("rejects a two-character state that is not letters", async () => {
    const state = await start({ state: "12" });

    if (state.status !== "error") throw new Error("expected an error state");
    expect(state.fieldErrors?.state).toBe("Use a two-letter state code.");
  });

  it("normalises a lowercase state to its canonical uppercase code", async () => {
    // Stripe Tax is handed this value, so "mt" must not reach it as typed.
    const state = await start({ state: "mt" });
    expect(state.status).toBe("ready");

    const [order] = await ctx.db.select().from(orders);
    expect(order.shippingAddress.state).toBe("MT");
  });

  it("stores no second address line when the optional field is left blank", async () => {
    await start({ line2: "" });

    const [order] = await ctx.db.select().from(orders);
    expect(order.shippingAddress.line2).toBeUndefined();
  });

  it("accepts a ZIP+4", async () => {
    const state = await start({ postalCode: "59715-1234" });
    expect(state.status).toBe("ready");
  });
});

describe("startCheckoutAction — order creation", () => {
  it("creates a pending order and returns what the payment step needs", async () => {
    const state = await start();

    if (state.status !== "ready") throw new Error(`unexpected: ${state.status}`);
    expect(state.clientSecret).toBeTruthy();
    expect(state.email).toBe("buyer@example.com");
    expect(state.orderNumber).toBeGreaterThan(0);

    // $45.00 + $6.00 shipping = $51.00 taxable, 8% fake tax = $4.08.
    expect(state.totalCents).toBe(5508);

    const [order] = await ctx.db.select().from(orders);
    expect(order.status).toBe("pending");
    expect(order.totalCents).toBe(5508);
    expect(order.cartId).toBe(cookieCartId);
  });

  it("remembers the pending order in a cookie", async () => {
    await start();

    const [order] = await ctx.db.select().from(orders);
    expect(jar.get("cs_pending_order")).toBe(order.id);
  });

  it("grants this browser access to the order it just created", async () => {
    await start();

    const [order] = await ctx.db.select().from(orders);
    // Without this the customer is redirected to a confirmation page they
    // cannot read, since the email no longer travels in the URL.
    expect(jar.get("cs_order_access")).toBe(order.id);
  });

  it("reuses the pending order when the address is edited", async () => {
    const first = await start();
    if (first.status !== "ready") throw new Error("expected ready");

    const second = await start({ line1: "2 Powder Lane" });
    if (second.status !== "ready") throw new Error("expected ready");

    // One order, one reservation — editing must not stack a second of either.
    expect(second.orderNumber).toBe(first.orderNumber);
    expect(await ctx.db.select().from(orders)).toHaveLength(1);

    const [stock] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, bottleId));
    expect(stock.reserved).toBe(1);

    const [order] = await ctx.db.select().from(orders);
    expect(order.shippingAddress.line1).toBe("2 Powder Lane");
  });

  it("refuses an empty cart", async () => {
    await ctx.db.delete(cartItems).where(eq(cartItems.cartId, cookieCartId!));

    const state = await start();
    expect(state).toEqual({ status: "error", error: "Your cart is empty." });
  });
});

describe("startCheckoutAction — out of stock", () => {
  it("names the product and clamps the cart to what is left", async () => {
    await ctx.db
      .update(cartItems)
      .set({ quantity: 4 })
      .where(eq(cartItems.cartId, cookieCartId!));
    // Only 2 of the 5 remain unreserved.
    await ctx.db
      .update(inventory)
      .set({ reserved: 3 })
      .where(eq(inventory.productId, bottleId));

    const state = await start();

    expect(state).toEqual({
      status: "error",
      error: "Only 2 left of Coldsmoke Eau de Toilette. We updated your cart.",
    });

    const [item] = await ctx.db
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, cookieCartId!));
    expect(item.quantity).toBe(2);

    // The failed reservation must not have left an order behind.
    expect(await ctx.db.select().from(orders)).toHaveLength(0);
  });

  it("removes a line that has sold out entirely", async () => {
    await ctx.db
      .update(inventory)
      .set({ reserved: 5 })
      .where(eq(inventory.productId, bottleId));

    const state = await start();

    expect(state).toEqual({
      status: "error",
      error:
        "Coldsmoke Eau de Toilette just sold out. We removed it from your cart.",
    });

    const rows = await ctx.db
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, cookieCartId!));
    expect(rows).toHaveLength(0);
  });
});
