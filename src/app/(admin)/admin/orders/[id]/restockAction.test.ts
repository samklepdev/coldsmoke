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

// A spy rather than a plain stub, so the gate itself can be asserted. Mocking
// the module wholesale is what would make deleting requireAdminUser from
// restockAction or writeOffAction invisible to the whole suite -- see "the
// admin gate" below.
const requireAdminUser = vi.fn(async () => ({
  id: "admin1",
  email: "admin@example.com",
  name: "Admin",
  role: "admin",
  emailVerified: true,
}));
vi.mock("@/lib/auth/session", () => ({
  requireAdminUser: () => requireAdminUser(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Wraps the real implementations by default, so every existing test still
// talks to the actual functions. A test that needs the underlying call to
// misbehave overrides one function for a single call with mockRejectedValueOnce
// and lets the wrapper fall back to the real implementation afterwards.
vi.mock("@/lib/orders/restock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orders/restock")>();
  return {
    ...actual,
    restockRefundedOrder: vi.fn(actual.restockRefundedOrder),
    writeOffOrderStock: vi.fn(actual.writeOffOrderStock),
  };
});

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
  requireAdminUser.mockClear();
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
const restockLib = await import("@/lib/orders/restock");

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

  it("refuses a blank quantity instead of treating it as zero", async () => {
    const { order, item } = await refundedOrder(2);

    const form = new FormData();
    form.set("orderId", order.id);
    form.set(`quantity:${item.id}`, "   ");

    const state = await restockAction({ status: "idle" }, form);

    expect(state).toEqual({
      status: "error",
      error: "Enter whole numbers of units.",
    });
    const [stock] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    expect(stock.onHand).toBe(10);
  });

  it("refuses a corrupted order-item id instead of letting Postgres reject it", async () => {
    // quantity:<id> is parsed by slicing the field name -- a crafted or
    // corrupted POST like quantity:abc=1 would otherwise reach
    // eq(orderItems.id, "abc") on a uuid column and come back from Postgres
    // as an unhandled 22P02, surfacing as an opaque 500 instead of the
    // friendly refusal every other bad input on this form receives.
    const { order } = await refundedOrder(2);

    const form = new FormData();
    form.set("orderId", order.id);
    form.set("quantity:not-a-uuid", "1");

    const state = await restockAction({ status: "idle" }, form);

    expect(state).toEqual({
      status: "error",
      error: "Enter whole numbers of units.",
    });
    const [stock] = await ctx.db
      .select()
      .from(inventory)
      .where(eq(inventory.productId, productId));
    expect(stock.onHand).toBe(10);
  });

  it("rejects rather than reporting a friendly error when restock fails unexpectedly", async () => {
    const { order, item } = await refundedOrder(1);

    vi.mocked(restockLib.restockRefundedOrder).mockRejectedValueOnce(
      new Error("connection reset"),
    );

    const form = new FormData();
    form.set("orderId", order.id);
    form.set(`quantity:${item.id}`, "1");

    await expect(restockAction({ status: "idle" }, form)).rejects.toThrow(
      "connection reset",
    );
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

    // The status alone would also pass if the action did nothing at all --
    // the observable effect is that the order is stamped decided.
    const [updated] = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(updated.stockDecisionAt).not.toBeNull();
  });

  it("rejects rather than reporting a friendly error when the write-off fails unexpectedly", async () => {
    const { order } = await refundedOrder(1);

    vi.mocked(restockLib.writeOffOrderStock).mockRejectedValueOnce(
      new Error("connection reset"),
    );

    const form = new FormData();
    form.set("orderId", order.id);

    await expect(writeOffAction({ status: "idle" }, form)).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("the admin gate", () => {
  it("is called by restockAction and writeOffAction", async () => {
    // These two actions mutate inventory, so an unenforced gate here is worse
    // than on the read-mostly actions: mocking the session module wholesale
    // means deleting requireAdminUser would leave every other test in this
    // file green. Assert the call itself, matching the pattern in
    // actions.test.ts's "the admin gate".
    const { order, item } = await refundedOrder(2);

    requireAdminUser.mockClear();
    const restockForm = new FormData();
    restockForm.set("orderId", order.id);
    restockForm.set(`quantity:${item.id}`, "1");
    await restockAction({ status: "idle" }, restockForm);
    expect(requireAdminUser).toHaveBeenCalledTimes(1);

    requireAdminUser.mockClear();
    const writeOffForm = new FormData();
    writeOffForm.set("orderId", order.id);
    await writeOffAction({ status: "idle" }, writeOffForm);
    expect(requireAdminUser).toHaveBeenCalledTimes(1);
  });
});
