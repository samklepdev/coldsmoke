import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
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

const {
  createDiscountCode,
  deactivateDiscountCode,
  listDiscountCodes,
  DiscountInputError,
} = await import("./admin");

const VALID = {
  code: "spring15",
  type: "percent" as const,
  value: 15,
  minSubtotalCents: 0,
  maxRedemptions: null,
  startsAt: null,
  endsAt: new Date("2099-01-01T00:00:00Z"),
};

async function rows() {
  return ctx.db.select().from(discountCodes);
}

describe("createDiscountCode", () => {
  it("persists every field", async () => {
    const startsAt = new Date("2026-01-01T00:00:00Z");
    const created = await createDiscountCode({
      ...VALID,
      code: "spring15",
      minSubtotalCents: 5000,
      maxRedemptions: 100,
      startsAt,
    });

    expect(created.code).toBe("spring15");
    expect(created.type).toBe("percent");
    expect(created.value).toBe(15);
    expect(created.minSubtotalCents).toBe(5000);
    expect(created.maxRedemptions).toBe(100);
    expect(created.timesRedeemed).toBe(0);
    expect(created.active).toBe(true);
    // By VALUE, not just not-null. Asserting only that dates are present let
    // the insert drop startsAt entirely -- taking every scheduled promotion
    // live on creation -- with all 170 tests in src/lib/discounts and src/app
    // still passing.
    expect(created.startsAt).toEqual(startsAt);
    expect(created.endsAt).toEqual(VALID.endsAt);
  });

  it("lowercases the code", async () => {
    // There is a CHECK (code = lower(code)) constraint, so a mixed-case
    // insert would otherwise fail as an opaque database error.
    const created = await createDiscountCode({ ...VALID, code: "SPRING15" });

    expect(created.code).toBe("spring15");
  });

  it("refuses a code with no end date", async () => {
    await expect(
      // @ts-expect-error - the type forbids it; this guards the runtime too,
      // because form input arrives untyped.
      createDiscountCode({ ...VALID, endsAt: null }),
    ).rejects.toThrow(DiscountInputError);

    expect(await rows()).toHaveLength(0);
  });

  it("refuses a percentage outside 1-100", async () => {
    await expect(
      createDiscountCode({ ...VALID, value: 0 }),
    ).rejects.toThrow(DiscountInputError);
    await expect(
      createDiscountCode({ ...VALID, value: 101 }),
    ).rejects.toThrow(DiscountInputError);

    expect(await rows()).toHaveLength(0);
  });

  it("refuses an end date before the start date", async () => {
    await expect(
      createDiscountCode({
        ...VALID,
        startsAt: new Date("2030-01-01T00:00:00Z"),
        endsAt: new Date("2029-01-01T00:00:00Z"),
      }),
    ).rejects.toThrow(DiscountInputError);
  });

  it("reports a duplicate code as a friendly error and inserts nothing", async () => {
    await createDiscountCode(VALID);

    await expect(createDiscountCode(VALID)).rejects.toThrow(DiscountInputError);

    expect(await rows()).toHaveLength(1);
  });
});

describe("deactivateDiscountCode", () => {
  it("switches the code off and changes nothing else", async () => {
    const created = await createDiscountCode({
      ...VALID,
      maxRedemptions: 10,
      minSubtotalCents: 2500,
    });
    await ctx.db
      .update(discountCodes)
      .set({ timesRedeemed: 3 })
      .where(eq(discountCodes.id, created.id));

    await deactivateDiscountCode(created.id);

    const [after] = await ctx.db
      .select()
      .from(discountCodes)
      .where(eq(discountCodes.id, created.id));

    expect(after.active).toBe(false);
    // A deactivate that quietly rewrote terms would corrupt what past orders
    // reference, so assert the rest is untouched rather than only the flag.
    expect(after.timesRedeemed).toBe(3);
    expect(after.maxRedemptions).toBe(10);
    expect(after.minSubtotalCents).toBe(2500);
    expect(after.value).toBe(created.value);
    expect(after.endsAt).toEqual(created.endsAt);
  });
});

describe("listDiscountCodes", () => {
  it("returns codes newest first", async () => {
    // The admin list used to order by `id`, which is a random v4 uuid: with
    // eight codes the one just created rendered sixth.
    //
    // Inserted in an order that is deliberately NOT alphabetical. An ascending
    // fixture made this test pass for the wrong reason: the tie-break on
    // `code` reproduced the expected reversal on its own, so dropping the
    // createdAt term entirely -- the whole point of migration 0009 -- left the
    // suite green.
    const codes = ["hhh8", "aaa1", "ggg7", "ccc3", "fff6", "bbb2", "eee5", "ddd4"];
    for (const code of codes) {
      await createDiscountCode({ ...VALID, code });
    }

    const listed = await listDiscountCodes();

    expect(listed.map((c) => c.code)).toEqual([...codes].reverse());
  });

  it("orders rows sharing a timestamp deterministically", async () => {
    // Every row that predates the created_at column carries the migration's
    // timestamp, so ties are the normal case on an existing database, not an
    // edge case. Without a tiebreak their order is whatever Postgres returns.
    const now = new Date("2026-01-01T00:00:00Z");
    for (const code of ["tie-a", "tie-b", "tie-c"]) {
      await createDiscountCode({ ...VALID, code });
      await ctx.db
        .update(discountCodes)
        .set({ createdAt: now })
        .where(eq(discountCodes.code, code));
    }

    const first = await listDiscountCodes();
    const second = await listDiscountCodes();

    expect(first.map((c) => c.code)).toEqual(["tie-c", "tie-b", "tie-a"]);
    expect(second.map((c) => c.code)).toEqual(first.map((c) => c.code));
  });
});
