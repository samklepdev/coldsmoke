import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { user } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const { listAddresses, createAddress, deleteAddress, setDefaultAddress } =
  await import("./index");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  await ctx.db.insert(user).values([
    { id: "user_1", name: "Buyer One", email: "one@example.com", emailVerified: true },
    { id: "user_2", name: "Buyer Two", email: "two@example.com", emailVerified: true },
  ]);
});

const INPUT = {
  label: "Home",
  name: "Test Buyer",
  line1: "1 Powder Lane",
  city: "Bozeman",
  state: "MT",
  postalCode: "59715",
  country: "US",
};

describe("addresses", () => {
  it("saves an address for a customer", async () => {
    await createAddress("user_1", INPUT);

    const saved = await listAddresses("user_1");
    expect(saved).toHaveLength(1);
    expect(saved[0].line1).toBe("1 Powder Lane");
  });

  it("makes the first address the default", async () => {
    // Otherwise a customer with exactly one address has no default, and
    // checkout has nothing to preselect.
    await createAddress("user_1", INPUT);

    expect((await listAddresses("user_1"))[0].isDefault).toBe(true);
  });

  it("does not make later addresses the default", async () => {
    await createAddress("user_1", INPUT);
    const second = await createAddress("user_1", { ...INPUT, label: "Work" });

    expect(second.isDefault).toBe(false);
  });

  it("moves the default rather than adding a second one", async () => {
    const first = await createAddress("user_1", INPUT);
    const second = await createAddress("user_1", { ...INPUT, label: "Work" });

    await setDefaultAddress("user_1", second.id);

    const saved = await listAddresses("user_1");
    expect(saved.filter((a) => a.isDefault).map((a) => a.id)).toEqual([second.id]);
    expect(saved.find((a) => a.id === first.id)?.isDefault).toBe(false);
  });

  it("never lists another customer's addresses", async () => {
    await createAddress("user_2", INPUT);

    expect(await listAddresses("user_1")).toEqual([]);
  });

  it("refuses to delete an address belonging to someone else", async () => {
    const theirs = await createAddress("user_2", INPUT);

    expect(await deleteAddress("user_1", theirs.id)).toBe(false);
    expect(await listAddresses("user_2")).toHaveLength(1);
  });

  it("refuses to promote an address belonging to someone else", async () => {
    const theirs = await createAddress("user_2", INPUT);

    expect(await setDefaultAddress("user_1", theirs.id)).toBe(false);
  });

  it("deletes the customer's own address", async () => {
    const mine = await createAddress("user_1", INPUT);

    expect(await deleteAddress("user_1", mine.id)).toBe(true);
    expect(await listAddresses("user_1")).toEqual([]);
  });
});
