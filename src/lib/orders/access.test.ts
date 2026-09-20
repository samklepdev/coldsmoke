import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { products, inventory, orders, orderItems } from "@/lib/db/schema";

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

const { grantOrderAccess, readGrantedOrderIds } = await import("./access");
const { findOrderByNumberForIds } = await import("./index");

let productId: string;

async function makeOrder(email: string) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email,
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

  await ctx.db.insert(orderItems).values({
    orderId: order.id,
    productId,
    name: "Coldsmoke Eau de Toilette",
    unitPriceCents: 4500,
    quantity: 1,
    totalCents: 4500,
  });

  return order;
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
  productId = bottle.id;
  await ctx.db.insert(inventory).values({ productId, onHand: 5 });
});

describe("the access cookie", () => {
  it("remembers a granted order", async () => {
    await grantOrderAccess("11111111-1111-4111-8111-111111111111");

    expect(await readGrantedOrderIds()).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("keeps earlier orders, most recent first", async () => {
    await grantOrderAccess("aaaaaaaa-0000-4000-8000-000000000001");
    await grantOrderAccess("bbbbbbbb-0000-4000-8000-000000000002");

    expect(await readGrantedOrderIds()).toEqual([
      "bbbbbbbb-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000001",
    ]);
  });

  it("does not duplicate a re-granted order", async () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000001";
    await grantOrderAccess(id);
    await grantOrderAccess("bbbbbbbb-0000-4000-8000-000000000002");
    await grantOrderAccess(id);

    const granted = await readGrantedOrderIds();
    expect(granted.filter((x) => x === id)).toHaveLength(1);
    expect(granted[0]).toBe(id);
  });

  it("caps the list so the cookie cannot grow without bound", async () => {
    for (let i = 0; i < 15; i++) {
      await grantOrderAccess(`aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`);
    }

    expect(await readGrantedOrderIds()).toHaveLength(10);
  });

  it("reads as empty when no cookie is set", async () => {
    expect(await readGrantedOrderIds()).toEqual([]);
  });

  it("ignores a malformed cookie value", async () => {
    jar.set("cs_order_access", " , ,, ");
    expect(await readGrantedOrderIds()).toEqual([]);
  });
});

describe("findOrderByNumberForIds", () => {
  it("returns the order when the id is granted", async () => {
    const order = await makeOrder("buyer@example.com");

    const found = await findOrderByNumberForIds(order.orderNumber, [order.id]);

    expect(found?.id).toBe(order.id);
    expect(found?.items).toHaveLength(1);
  });

  it("returns nothing when no ids are granted", async () => {
    // The dangerous shape: "no credentials" must not degrade to "no filter".
    const order = await makeOrder("buyer@example.com");

    expect(await findOrderByNumberForIds(order.orderNumber, [])).toBeNull();
  });

  it("refuses an order number whose id was not granted", async () => {
    const mine = await makeOrder("buyer@example.com");
    const theirs = await makeOrder("someone@else.com");

    // Knowing a neighbouring order number is not access to it.
    const found = await findOrderByNumberForIds(theirs.orderNumber, [mine.id]);

    expect(found).toBeNull();
  });

  it("refuses a forged id", async () => {
    const order = await makeOrder("buyer@example.com");

    const found = await findOrderByNumberForIds(order.orderNumber, [
      "99999999-9999-4999-8999-999999999999",
    ]);

    expect(found).toBeNull();
  });

  it("matches only the requested order number among several granted", async () => {
    const first = await makeOrder("buyer@example.com");
    const second = await makeOrder("buyer@example.com");

    const found = await findOrderByNumberForIds(second.orderNumber, [
      first.id,
      second.id,
    ]);

    expect(found?.id).toBe(second.id);
  });
});
