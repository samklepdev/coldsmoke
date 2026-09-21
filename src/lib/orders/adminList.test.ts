import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { orders } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;

// adminList.ts reads `db` from @/lib/db/client, which points at DATABASE_URL
// (the dev database) rather than TEST_DATABASE_URL. Without this mock the
// fixtures below and the query under test would land in two different
// databases. Same pattern as claim.test.ts and access.test.ts.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { listOrdersForAdmin } = await import("./adminList");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

const ADDRESS = {
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US" as const,
};

async function seed(email: string, status: "paid" | "pending" | "fulfilled") {
  const [order] = await ctx.db
    .insert(orders)
    .values({
      email,
      status,
      subtotalCents: 4500,
      totalCents: 5100,
      shippingAddress: ADDRESS,
    })
    .returning();
  return order;
}

describe("listOrdersForAdmin", () => {
  it("returns the newest order first", async () => {
    await seed("first@example.com", "paid");
    await seed("second@example.com", "paid");

    const { rows } = await listOrdersForAdmin({});

    expect(rows[0].email).toBe("second@example.com");
  });

  it("filters by status", async () => {
    await seed("paid@example.com", "paid");
    await seed("pending@example.com", "pending");

    const { rows } = await listOrdersForAdmin({ status: "paid" });

    expect(rows.map((r) => r.email)).toEqual(["paid@example.com"]);
  });

  it("finds an order by its number when the query is all digits", async () => {
    const seeded = await seed("buyer@example.com", "paid");
    await seed("other@example.com", "paid");

    const { rows } = await listOrdersForAdmin({
      query: String(seeded.orderNumber),
    });

    expect(rows.map((r) => r.id)).toEqual([seeded.id]);
  });

  it("finds an order by email prefix, ignoring case", async () => {
    await seed("Buyer@Example.com", "paid");
    await seed("someone@example.com", "paid");

    const { rows } = await listOrdersForAdmin({ query: "buyer" });

    expect(rows.map((r) => r.email)).toEqual(["Buyer@Example.com"]);
  });

  it("reports the unpaginated total alongside the page", async () => {
    await seed("a@example.com", "paid");
    await seed("b@example.com", "paid");

    const result = await listOrdersForAdmin({});

    expect(result.total).toBe(2);
    expect(result.pageSize).toBe(50);
    expect(result.page).toBe(1);
  });

  it("treats a page below 1 as the first page", async () => {
    await seed("a@example.com", "paid");

    const result = await listOrdersForAdmin({ page: 0 });

    expect(result.page).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it("ignores a status that is not a real order status", async () => {
    // The value arrives from a URL, so it is attacker-controlled. An
    // unrecognised one must mean "no filter", never an error page.
    await seed("a@example.com", "paid");

    const { rows } = await listOrdersForAdmin({ status: "nonsense" });

    expect(rows).toHaveLength(1);
  });
});
