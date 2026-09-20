import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";
import type { Address } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { claimGuestOrders } = await import("./claim");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

const ADDRESS: Address = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

async function placeOrder(email: string, userId: string | null = null) {
  const [row] = await ctx.db
    .insert(orders)
    .values({
      email,
      userId,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingAddress: ADDRESS,
    })
    .returning({ id: orders.id });
  return row.id;
}

describe("claimGuestOrders", () => {
  it("attaches a guest order placed with the same address", async () => {
    const orderId = await placeOrder("buyer@example.com");

    const claimed = await claimGuestOrders({
      userId: "user_1",
      email: "buyer@example.com",
    });

    expect(claimed).toBe(1);
    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row.userId).toBe("user_1");
  });

  it("matches the address case-insensitively", async () => {
    // Checkout stores the address as typed; Better Auth lowercases it. Without
    // a case-insensitive match, anyone who typed a capital at checkout never
    // sees that order again.
    await placeOrder("Buyer@Example.com");

    expect(
      await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" }),
    ).toBe(1);
  });

  it("leaves another customer's orders alone", async () => {
    const otherId = await placeOrder("someone-else@example.com");

    await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" });

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, otherId));
    expect(row.userId).toBeNull();
  });

  it("never steals an order that already belongs to an account", async () => {
    // The dangerous case: same address, already claimed. Reassigning it would
    // move one customer's order into another customer's history.
    const orderId = await placeOrder("buyer@example.com", "user_original");

    await claimGuestOrders({ userId: "user_2", email: "buyer@example.com" });

    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
    expect(row.userId).toBe("user_original");
  });

  it("claims every matching guest order, not just the first", async () => {
    await placeOrder("buyer@example.com");
    await placeOrder("buyer@example.com");
    await placeOrder("buyer@example.com");

    expect(
      await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" }),
    ).toBe(3);
  });

  it("claims nothing the second time", async () => {
    await placeOrder("buyer@example.com");
    await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" });

    expect(
      await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" }),
    ).toBe(0);
  });

  it("returns zero when there is nothing to claim", async () => {
    expect(
      await claimGuestOrders({ userId: "user_1", email: "buyer@example.com" }),
    ).toBe(0);
  });
});
