import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "@/test/db";
import { user } from "@/lib/db/schema";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

type SendArgs = { to: string; url: string };
const sendExistingAccountEmail = vi.fn(async (_args: SendArgs) => ({ delivered: true }));
const sendVerificationEmail = vi.fn(async (_args: SendArgs) => ({ delivered: true }));
vi.mock("@/lib/email/auth", () => ({
  sendExistingAccountEmail: (args: SendArgs) => sendExistingAccountEmail(args),
  sendVerificationEmail: (args: SendArgs) => sendVerificationEmail(args),
  sendPasswordResetEmail: vi.fn(async (_args: SendArgs) => ({ delivered: true })),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const { signUpAction } = await import("./actions");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  sendExistingAccountEmail.mockClear();
  sendVerificationEmail.mockClear();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const VALID = {
  name: "Test Buyer",
  email: "buyer@example.com",
  password: "a long enough password",
};

describe("signUpAction", () => {
  it("creates an unverified account", async () => {
    const state = await signUpAction({ status: "idle" }, form(VALID));

    expect(state.status).toBe("sent");
    const [row] = await ctx.db
      .select()
      .from(user)
      .where(eq(user.email, "buyer@example.com"));
    // Unverified until the link is clicked. This is what gates the order
    // history claim in Task 6.
    expect(row.emailVerified).toBe(false);
  });

  it("defaults a new account to the customer role", async () => {
    await signUpAction({ status: "idle" }, form(VALID));

    const [row] = await ctx.db
      .select()
      .from(user)
      .where(eq(user.email, "buyer@example.com"));
    expect(row.role).toBe("customer");
  });

  it("rejects a short password with a reason", async () => {
    const state = await signUpAction(
      { status: "idle" },
      form({ ...VALID, password: "short" }),
    );

    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { password: "Use at least 8 characters." },
    });
  });

  it("rejects an invalid address with a reason", async () => {
    const state = await signUpAction(
      { status: "idle" },
      form({ ...VALID, email: "not-an-address" }),
    );

    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { email: "Enter a valid email address." },
    });
  });

  it("does not create a second account for an address already registered", async () => {
    await signUpAction({ status: "idle" }, form(VALID));
    await signUpAction({ status: "idle" }, form(VALID));

    const rows = await ctx.db
      .select()
      .from(user)
      .where(eq(user.email, "buyer@example.com"));
    expect(rows).toHaveLength(1);
  });

  it("gives a duplicate sign-up the same answer as a new one", async () => {
    await signUpAction({ status: "idle" }, form(VALID));
    const second = await signUpAction({ status: "idle" }, form(VALID));

    // The whole point: the browser cannot tell the two cases apart, so the
    // form is not an oracle for which addresses have accounts here.
    expect(second).toEqual({ status: "sent", email: "buyer@example.com" });
  });

  it("tells the existing account holder by email instead", async () => {
    await signUpAction({ status: "idle" }, form(VALID));
    sendExistingAccountEmail.mockClear();

    await signUpAction({ status: "idle" }, form(VALID));

    expect(sendExistingAccountEmail).toHaveBeenCalledTimes(1);
  });
});
