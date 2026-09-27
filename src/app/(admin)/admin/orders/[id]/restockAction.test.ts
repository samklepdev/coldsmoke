import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { products, inventory, orders, orderItems } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
let productId: string;

// The action reaches the database through @/lib/db/client, which resolves
// DATABASE_URL -- the dev database -- while testDb() connects to the test
// one. Without this the fixtures and the code under test would sit in two
// different databases and the assertions would mean nothing.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

vi.mock("@/lib/auth/session", () => ({
  requireAdminUser: async () => ({
    id: "admin1",
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    emailVerified: true,
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US" as const,
};

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  const [product] = await ctx.db
    .insert(products)
    .values({
      slug: "test-edt",
      name: "Test EDT",
      description: "Test",
      priceCents: 4500,
      sku: "T-1",
    })
    .returning();
  productId = product.id;
  await ctx.db.insert(inventory).values({ productId, onHand: 10 });
});

const { restockAction, writeOffAction } = await import("./actions");

async function refundedOrder(quantity: number) {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email: "buyer@example.com",
      status: "refunded",
      inventoryState: "committed",
      refundedCents: 5100,
      subtotalCents: 4500,
      shippingCents: 600,
      taxCents: 0,
      discountCents: 0,
      totalCents: 5100,
      shippingAddress: ADDRESS,
    })
    .returning();

  const [item] = await ctx.db
    .insert(orderItems)
    .values({
      orderId: order.id,
      productId,
      name: "Test EDT",
      unitPriceCents: 4500,
      quantity,
      totalCents: 4500 * quantity,
    })
    .returning();

  return { order, item };
}

describe("restockAction", () => {
  it("restocks the submitted quantities", async () => {
    const { order, item } = await refundedOrder(2);

    const form = new FormData();
    form.set("orderId", order.id);
    form.set(`quantity:${item.id}`, "2");

    const state = await restockAction({ status: "idle" }, form);

    expect(state).toEqual({ status: "restocked", units: 2 });
    const [stock] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    expect(stock.onHand).toBe(12);
  });

  it("reports a refusal instead of throwing", async () => {
    const { order, item } = await refundedOrder(1);

    const form = new FormData();
    form.set("orderId", order.id);
    form.set(`quantity:${item.id}`, "9");

    const state = await restockAction({ status: "idle" }, form);

    expect(state.status).toBe("error");
  });

  it("rejects an order with no refund", async () => {
    const { order, item } = await refundedOrder(1);
    await ctx.db
      .update(orders)
      .set({ refundedCents: 0 })
      .where(eq(orders.id, order.id));

    const form = new FormData();
    form.set("orderId", order.id);
    form.set(`quantity:${item.id}`, "1");

    expect((await restockAction({ status: "idle" }, form)).status).toBe("error");
  });
});

describe("writeOffAction", () => {
  it("records the decision without touching stock", async () => {
    const { order } = await refundedOrder(2);

    const form = new FormData();
    form.set("orderId", order.id);

    const state = await writeOffAction({ status: "idle" }, form);

    expect(state).toEqual({ status: "written-off" });
    const [stock] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    expect(stock.onHand).toBe(10);
  });
});
