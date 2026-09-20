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

/** Shared stub: every auth email reports a clean delivery. */
const mockSend = async () => ({ delivered: true });
vi.mock("@/lib/email/auth", () => ({
  sendVerificationEmail: vi.fn(mockSend),
  sendPasswordResetEmail: vi.fn(mockSend),
  sendExistingAccountEmail: vi.fn(mockSend),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const mergeGuestCart = vi.fn<(userId: string) => Promise<void>>(async () => {});
vi.mock("@/lib/cart/merge", () => ({
  mergeGuestCart: (userId: string) => mergeGuestCart(userId),
}));

const { signInAction } = await import("./actions");
const { auth } = await import("@/lib/auth");

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  mergeGuestCart.mockClear();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const CREDENTIALS = { email: "buyer@example.com", password: "a long enough password" };

async function createAccount(verified: boolean) {
  await auth.api.signUpEmail({
    body: { name: "Test Buyer", ...CREDENTIALS },
    headers: new Headers(),
  });
  if (verified) {
    await ctx.db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.email, CREDENTIALS.email));
  }
}

describe("signInAction", () => {
  it("signs in a verified account", async () => {
    await createAccount(true);

    const state = await signInAction({ status: "idle" }, form(CREDENTIALS));

    expect(state.status).toBe("ok");
  });

  it("refuses an unverified account and says so", async () => {
    await createAccount(false);

    const state = await signInAction({ status: "idle" }, form(CREDENTIALS));

    // Distinct from a wrong password: the customer needs to know the account
    // exists and what to do about it, and this is not an enumeration leak --
    // they already proved they know the password.
    expect(state).toMatchObject({ status: "unverified", email: CREDENTIALS.email });
  });

  it("refuses a wrong password without saying which field was wrong", async () => {
    await createAccount(true);

    const state = await signInAction(
      { status: "idle" },
      form({ ...CREDENTIALS, password: "not the password" }),
    );

    expect(state).toEqual({
      status: "error",
      error: "That email and password do not match.",
    });
  });

  it("gives an unknown address the same answer as a wrong password", async () => {
    const state = await signInAction(
      { status: "idle" },
      form({ email: "nobody@example.com", password: "whatever it is" }),
    );

    expect(state).toEqual({
      status: "error",
      error: "That email and password do not match.",
    });
  });

  it("merges the guest cart on a successful sign-in", async () => {
    await createAccount(true);

    await signInAction({ status: "idle" }, form(CREDENTIALS));

    expect(mergeGuestCart).toHaveBeenCalledTimes(1);
  });

  it("does not merge a cart when sign-in fails", async () => {
    await createAccount(true);

    await signInAction(
      { status: "idle" },
      form({ ...CREDENTIALS, password: "wrong" }),
    );

    expect(mergeGuestCart).not.toHaveBeenCalled();
  });
});
