import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

type SendArgs = { to: string; url: string };
vi.mock("@/lib/email/auth", () => ({
  sendVerificationEmail: vi.fn(async (_args: SendArgs) => ({ delivered: true })),
  sendPasswordResetEmail: vi.fn(async (_args: SendArgs) => ({ delivered: true })),
  sendExistingAccountEmail: vi.fn(async (_args: SendArgs) => ({ delivered: true })),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { resetPasswordAction } = await import("./actions");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("resetPasswordAction", () => {
  it("refuses a token that does not exist", async () => {
    const state = await resetPasswordAction(
      { status: "idle" },
      form({ token: "not-a-real-token", password: "a long enough password" }),
    );

    expect(state).toEqual({
      status: "error",
      error: "That reset link has expired. Ask for a new one.",
    });
  });

  it("refuses a short password before spending the token", async () => {
    const state = await resetPasswordAction(
      { status: "idle" },
      form({ token: "whatever", password: "short" }),
    );

    expect(state).toMatchObject({
      status: "error",
      fieldErrors: { password: "Use at least 8 characters." },
    });
  });

  it("refuses a missing token outright", async () => {
    const state = await resetPasswordAction(
      { status: "idle" },
      form({ token: "", password: "a long enough password" }),
    );

    expect(state.status).toBe("error");
  });
});
