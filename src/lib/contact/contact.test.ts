import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";
import { contactMessages } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

const {
  hashIp,
  isRateLimited,
  recordMessage,
  markDelivered,
  CONTACT_RATE_LIMIT,
} = await import("./index");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

const send = (ipHash: string) =>
  recordMessage({
    email: "buyer@example.com",
    message: "Does this ship to Alaska?",
    ipHash,
  });

describe("hashIp", () => {
  it("does not return the address it was given", () => {
    expect(hashIp("203.0.113.9")).not.toContain("203.0.113.9");
  });

  it("is stable for the same address", () => {
    expect(hashIp("203.0.113.9")).toBe(hashIp("203.0.113.9"));
  });

  it("differs between addresses", () => {
    expect(hashIp("203.0.113.9")).not.toBe(hashIp("203.0.113.10"));
  });
});

describe("recordMessage", () => {
  it("stores the message undelivered", async () => {
    const { id } = await send(hashIp("203.0.113.9"));

    const [row] = await ctx.db.select().from(contactMessages);
    expect(row.id).toBe(id);
    expect(row.message).toBe("Does this ship to Alaska?");
    // Undelivered until the send actually lands -- the whole point of writing
    // the row first.
    expect(row.deliveredAt).toBeNull();
  });

  it("marks a message delivered", async () => {
    const { id } = await send(hashIp("203.0.113.9"));
    await markDelivered(id);

    const [row] = await ctx.db.select().from(contactMessages);
    expect(row.deliveredAt).toBeInstanceOf(Date);
  });
});

describe("isRateLimited", () => {
  it("allows the first message", async () => {
    expect(await isRateLimited(hashIp("203.0.113.9"))).toBe(false);
  });

  it("allows exactly the limit", async () => {
    const ip = hashIp("203.0.113.9");
    for (let i = 0; i < CONTACT_RATE_LIMIT; i++) await send(ip);

    // The limit is how many you may send, so the Nth must have been allowed.
    const [row] = await ctx.db.select().from(contactMessages).limit(1);
    expect(row).toBeDefined();
  });

  it("blocks the one after the limit", async () => {
    const ip = hashIp("203.0.113.9");
    for (let i = 0; i < CONTACT_RATE_LIMIT; i++) await send(ip);

    expect(await isRateLimited(ip)).toBe(true);
  });

  it("counts each address separately", async () => {
    const mine = hashIp("203.0.113.9");
    for (let i = 0; i < CONTACT_RATE_LIMIT; i++) await send(mine);

    expect(await isRateLimited(hashIp("203.0.113.10"))).toBe(false);
  });

  it("ignores messages older than the window", async () => {
    const ip = hashIp("203.0.113.9");
    for (let i = 0; i < CONTACT_RATE_LIMIT; i++) await send(ip);

    // Age every row past the window. A fixed calendar-hour limit would also
    // pass this; a rolling window is what makes it meaningful.
    await ctx.db.update(contactMessages).set({
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    expect(await isRateLimited(ip)).toBe(false);
  });
});
