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
