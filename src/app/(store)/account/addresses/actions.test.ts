import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { user, addresses } from "@/lib/db/schema";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// The action's ownership model is "the id comes from the session, never the
// form". These tests are about the state rule, so the session is a fixture.
vi.mock("@/lib/auth/session", () => ({
  requireSessionUser: async () => ({ id: "user_1" }),
}));

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { saveAddressAction } = await import("./actions");

const VALID = {
  label: "Home",
  name: "Test Buyer",
  line1: "1 Powder Lane",
  line2: "",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
};

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({ ...VALID, ...overrides })) {
    data.append(key, value);
  }
  return data;
}

async function save(overrides?: Record<string, string>) {
  return saveAddressAction({ status: "idle" }, form(overrides));
}

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  await ctx.db.insert(user).values({
    id: "user_1",
    name: "Buyer One",
    email: "one@example.com",
    emailVerified: true,
  });
});

describe("saveAddressAction — state validation", () => {
  it("rejects two letters that are not a state", async () => {
    // "XX" passed the old /^[A-Za-z]{2}$/ check and was stored as if real.
    const state = await save({ state: "XX" });

    if (state.status !== "error") throw new Error("expected an error state");
    expect(state.fieldErrors?.state).toBe("Choose a state.");
    expect(await ctx.db.select().from(addresses)).toHaveLength(0);
  });

  it("stores a lowercase code in its canonical uppercase form", async () => {
    const state = await save({ state: "mt" });
    expect(state.status).toBe("saved");

    const [saved] = await ctx.db.select().from(addresses);
    expect(saved.state).toBe("MT");
  });

  it("echoes the other fields back so one bad field costs one correction", async () => {
    const state = await save({ state: "XX" });

    if (state.status !== "error") throw new Error("expected an error state");
    expect(state.values?.line1).toBe("1 Powder Lane");
    expect(state.values?.city).toBe("Bozeman");
  });
});
