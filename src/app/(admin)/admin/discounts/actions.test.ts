import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { discountCodes } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;

// actions.ts reaches the database through @/lib/discounts/admin, which imports
// @/lib/db/client -- which resolves DATABASE_URL, the dev database, while
// testDb() connects to the test one. Without this the fixtures below and the
// code under test would sit in two different databases and the assertions
// would mean nothing.
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

// A spy rather than a plain stub, so the gate itself can be asserted. Mocking
// the session module wholesale is what would make deleting requireAdminUser
// from either action invisible to the rest of the suite -- see "the admin
// gate" below.
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

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  requireAdminUser.mockClear();
});

const { createDiscountAction, deactivateDiscountAction } = await import(
  "./actions"
);
const { createDiscountCode } = await import("@/lib/discounts/admin");
const adminModule = await import("@/lib/discounts/admin");

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const VALID_FIELDS = {
  code: "spring15",
  type: "percent",
  value: "15",
  minSubtotal: "0",
  maxRedemptions: "",
  startsAt: "",
  endsAt: "2099-01-01",
};

describe("createDiscountAction", () => {
  it("creates a code from form input", async () => {
    const state = await createDiscountAction({ status: "idle" }, form(VALID_FIELDS));

    expect(state).toEqual({ status: "created", code: "spring15" });
    const rows = await ctx.db.select().from(discountCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(15);
  });

  it("reports a refusal instead of throwing", async () => {
    const state = await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, value: "150" }),
    );

    expect(state.status).toBe("error");
    expect(await ctx.db.select().from(discountCodes)).toHaveLength(0);
  });

  it("converts a fixed amount from dollars to cents", async () => {
    await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, code: "tenoff", type: "fixed", value: "10" }),
    );

    const [row] = await ctx.db.select().from(discountCodes);
    expect(row.value).toBe(1000);
  });

  it("rejects rather than reporting a friendly error when something unexpected fails", async () => {
    // A genuine bug must surface, not be flattened into a message an admin
    // reads as normal.
    const boom = vi
      .spyOn(adminModule, "createDiscountCode")
      .mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      createDiscountAction({ status: "idle" }, form(VALID_FIELDS)),
    ).rejects.toThrow("connection reset");

    boom.mockRestore();
  });

  it("refuses a blank value instead of creating a 0-value code", async () => {
    const state = await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, value: "" }),
    );

    expect(state.status).toBe("error");
    expect(await ctx.db.select().from(discountCodes)).toHaveLength(0);
  });

  it("refuses a type that is not percent or fixed", async () => {
    const state = await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, type: "bogus" }),
    );

    expect(state.status).toBe("error");
    expect(await ctx.db.select().from(discountCodes)).toHaveLength(0);
  });

  it("refuses a malformed endsAt that would otherwise roll over to a valid date", async () => {
    // new Date("2099-02-30T...") does not produce Invalid Date -- it
    // silently rolls forward to March 2nd.
    const state = await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, endsAt: "2099-02-30" }),
    );

    expect(state.status).toBe("error");
    expect(await ctx.db.select().from(discountCodes)).toHaveLength(0);
  });

  it("treats endsAt as the end of the chosen day, not the start", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const state = await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, code: "endstoday", endsAt: today }),
    );

    expect(state).toEqual({ status: "created", code: "endstoday" });
    const [row] = await ctx.db.select().from(discountCodes);
    expect(row.endsAt).not.toBeNull();
    expect(row.endsAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a malformed startsAt rather than treating it as no restriction", async () => {
    const state = await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, startsAt: "2099-02-30" }),
    );

    expect(state.status).toBe("error");
    expect(await ctx.db.select().from(discountCodes)).toHaveLength(0);
  });

  it("refuses an unparseable redemption cap rather than creating an uncapped code", async () => {
    // Blank legitimately means "no cap". A typo must not collapse into that
    // same meaning: that turns a slip into the unbounded promotion the
    // required end date exists to prevent.
    const state = await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, maxRedemptions: "2.5" }),
    );

    expect(state.status).toBe("error");
    expect(await ctx.db.select().from(discountCodes)).toHaveLength(0);
  });

  it("still treats a blank redemption cap as unlimited", async () => {
    // The refusal above must not cost the legitimate "no cap" choice.
    const state = await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, code: "nocap", maxRedemptions: "" }),
    );

    expect(state).toEqual({ status: "created", code: "nocap" });
    const [row] = await ctx.db.select().from(discountCodes);
    expect(row.maxRedemptions).toBeNull();
  });

  it("converts a non-zero minSubtotal from dollars to cents", async () => {
    await createDiscountAction(
      { status: "idle" },
      form({ ...VALID_FIELDS, code: "min25", minSubtotal: "25" }),
    );

    const [row] = await ctx.db.select().from(discountCodes);
    expect(row.minSubtotalCents).toBe(2500);
  });

  it("revalidates the discounts admin path on a successful create", async () => {
    const { revalidatePath } = await import("next/cache");
    vi.mocked(revalidatePath).mockClear();

    await createDiscountAction({ status: "idle" }, form(VALID_FIELDS));

    expect(revalidatePath).toHaveBeenCalledWith("/admin/discounts");
  });
});

describe("deactivateDiscountAction", () => {
  it("switches the code off", async () => {
    const created = await createDiscountCode({
      code: "spring15",
      type: "percent",
      value: 15,
      minSubtotalCents: 0,
      maxRedemptions: null,
      startsAt: null,
      endsAt: new Date("2099-01-01T00:00:00Z"),
    });

    const state = await deactivateDiscountAction(
      { status: "idle" },
      form({ id: created.id }),
    );

    expect(state).toEqual({ status: "deactivated" });
    const [row] = await ctx.db.select().from(discountCodes);
    expect(row.active).toBe(false);
  });

  it("revalidates the discounts admin path on a successful deactivate", async () => {
    const created = await createDiscountCode({
      code: "revalme",
      type: "percent",
      value: 15,
      minSubtotalCents: 0,
      maxRedemptions: null,
      startsAt: null,
      endsAt: new Date("2099-01-01T00:00:00Z"),
    });

    const { revalidatePath } = await import("next/cache");
    vi.mocked(revalidatePath).mockClear();

    await deactivateDiscountAction({ status: "idle" }, form({ id: created.id }));

    expect(revalidatePath).toHaveBeenCalledWith("/admin/discounts");
  });
});

describe("the admin gate", () => {
  // The session module is mocked wholesale, so without these assertions
  // deleting requireAdminUser() from an action leaves every other test green.
  it("is called by createDiscountAction", async () => {
    requireAdminUser.mockClear();
    await createDiscountAction({ status: "idle" }, form(VALID_FIELDS));
    expect(requireAdminUser).toHaveBeenCalledTimes(1);
  });

  it("is called by deactivateDiscountAction", async () => {
    requireAdminUser.mockClear();
    await deactivateDiscountAction({ status: "idle" }, form({ id: crypto.randomUUID() }));
    expect(requireAdminUser).toHaveBeenCalledTimes(1);
  });
});
