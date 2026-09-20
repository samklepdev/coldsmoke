import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { products, inventory, orders, orderItems } from "@/lib/db/schema";

class RedirectSignal extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
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

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { lookupOrderAction } = await import("./actions");

let orderNumber: number;
let orderId: string;
const EMAIL = "buyer@example.com";

function form(orderNumberInput: string, email: string): FormData {
  const data = new FormData();
  data.append("orderNumber", orderNumberInput);
  data.append("email", email);
  return data;
}

/** Returns the redirect target, or null when the action returned instead. */
async function lookup(
  orderNumberInput: string,
  email: string,
): Promise<{ redirectedTo: string | null; error?: string }> {
  try {
    const state = await lookupOrderAction({}, form(orderNumberInput, email));
    return { redirectedTo: null, error: state.error };
  } catch (error) {
    if (error instanceof RedirectSignal) {
      return { redirectedTo: error.message };
    }
    throw error;
  }
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
      slug: "coldsmoke-edt-50ml",
      name: "Coldsmoke Eau de Toilette",
      description: "d",
      priceCents: 4500,
      sku: "CS-1",
    })
    .returning();
  await ctx.db.insert(inventory).values({ productId: bottle.id, onHand: 5 });

  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: EMAIL,
      status: "paid",
      subtotalCents: 4500,
      shippingCents: 600,
      taxCents: 408,
      totalCents: 5508,
      shippingAddress: {
        name: "Test Buyer",
        line1: "1 Powder Lane",
        city: "Bozeman",
        state: "MT",
        postalCode: "59715",
        country: "US",
      },
    })
    .returning();
  orderNumber = order.orderNumber;
  orderId = order.id;

  await ctx.db.insert(orderItems).values({
    orderId: order.id,
    productId: bottle.id,
    name: "Coldsmoke Eau de Toilette",
    unitPriceCents: 4500,
    quantity: 1,
    totalCents: 4500,
  });
});

describe("lookupOrderAction", () => {
  it("redirects to the order without putting the email in the URL", async () => {
    const result = await lookup(`CS-${orderNumber}`, EMAIL);

    expect(result.redirectedTo).toBe(`/order/${orderNumber}`);
    // The whole point of the change: no email, anywhere in the URL.
    expect(result.redirectedTo).not.toContain("email");
    expect(result.redirectedTo).not.toContain("@");
  });

  it("grants this browser access to the order it found", async () => {
    await lookup(`CS-${orderNumber}`, EMAIL);

    expect(jar.get("cs_order_access")).toBe(orderId);
  });

  it("grants nothing when the email does not match", async () => {
    await lookup(`CS-${orderNumber}`, "someone@else.com");

    expect(jar.has("cs_order_access")).toBe(false);
  });

  it("accepts the bare number without the CS- prefix", async () => {
    const result = await lookup(String(orderNumber), EMAIL);
    expect(result.redirectedTo).toBe(`/order/${orderNumber}`);
  });

  it("matches the email case-insensitively", async () => {
    const result = await lookup(`CS-${orderNumber}`, "BUYER@Example.com");
    expect(result.redirectedTo).toBe(`/order/${orderNumber}`);
  });

  it("refuses a real order number with the wrong email", async () => {
    const result = await lookup(`CS-${orderNumber}`, "someone@else.com");

    expect(result.redirectedTo).toBeNull();
    expect(result.error).toBe("We couldn't find that order. Check both fields.");
  });

  it("gives the same answer for an order number that does not exist", async () => {
    // The wrong-email and no-such-order cases must be indistinguishable, or
    // the form becomes an order-number oracle.
    const wrongEmail = await lookup(`CS-${orderNumber}`, "someone@else.com");
    const noSuchOrder = await lookup(`CS-${orderNumber + 9999}`, EMAIL);

    expect(noSuchOrder.error).toBe(wrongEmail.error);
    expect(noSuchOrder.redirectedTo).toBeNull();
  });

  it("rejects a malformed order number", async () => {
    const result = await lookup("not-a-number", EMAIL);

    expect(result.redirectedTo).toBeNull();
    expect(result.error).toBe("Enter your order number and the email you used.");
  });

  it("rejects a missing email", async () => {
    const result = await lookup(`CS-${orderNumber}`, "   ");

    expect(result.redirectedTo).toBeNull();
    expect(result.error).toBe("Enter your order number and the email you used.");
  });
});
