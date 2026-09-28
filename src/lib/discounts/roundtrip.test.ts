import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { discountCodes } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;

// admin.ts imports `db` at module scope, so without this the suite would talk
// to the dev database instead of the test one. The dynamic import below is
// what keeps the module load after the mock is registered.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

const { createDiscountCode } = await import("./admin");
const { lookupDiscount, validateDiscount, redeemDiscount } = await import("./index");

describe("a created code is redeemable", () => {
  it("validates and redeems through the customer path", async () => {
    await createDiscountCode({
      code: "ROUNDTRIP10",
      type: "percent",
      value: 10,
      minSubtotalCents: 0,
      maxRedemptions: 5,
      startsAt: null,
      endsAt: new Date("2099-01-01T00:00:00Z"),
    });

    // The customer types it in any case; lookup normalises.
    const found = await lookupDiscount("RoundTrip10");
    expect(found).not.toBeNull();

    const result = validateDiscount(found, 5000);
    expect(result.ok).toBe(true);

    await ctx.db.transaction(async (tx) => {
      expect(await redeemDiscount(tx, found!.id)).toBe(true);
    });

    const [after] = await ctx.db.select().from(discountCodes);
    expect(after.timesRedeemed).toBe(1);
  });
});
