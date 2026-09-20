import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { testDb } from "@/test/db";

let ctx: Awaited<ReturnType<typeof testDb>>;
vi.mock("@/lib/db/client", async () => {
  const { testDb } = await import("@/test/db");
  const shared = await testDb();
  return { db: shared.db };
});

type SendArgs = { to: string; url: string };
const mockSend = async () => ({ delivered: true });
type Send = (args: SendArgs) => Promise<{ delivered: boolean }>;
const sendVerificationEmail = vi.fn<Send>(mockSend);
vi.mock("@/lib/email/auth", () => ({
  sendExistingAccountEmail: vi.fn(mockSend),
  sendVerificationEmail: (args: SendArgs) => sendVerificationEmail(args),
  sendPasswordResetEmail: vi.fn(mockSend),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

const { resendVerificationAction } = await import("./actions");
const { signUpAction } = await import("../sign-up/actions");

const EMAIL = "buyer@example.com";

function form(email: string): FormData {
  const data = new FormData();
  data.set("email", email);
  return data;
}

/** Creates a real unverified account, so the resend path has something to send to. */
async function createAccount(): Promise<void> {
  const data = new FormData();
  data.set("name", "Test Buyer");
  data.set("email", EMAIL);
  data.set("password", "correct horse battery");
  await signUpAction({ status: "idle" }, data);
}

beforeAll(async () => {
  ctx = await testDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.truncate();
  sendVerificationEmail.mockReset();
  sendVerificationEmail.mockImplementation(mockSend);
});

describe("resendVerificationAction", () => {
  it("rejects an address that is not an address", async () => {
    const state = await resendVerificationAction({ status: "idle" }, form("nope"));

    expect(state).toMatchObject({ status: "error" });
  });

  it("confirms the send for an unverified account", async () => {
    await createAccount();

    const state = await resendVerificationAction({ status: "idle" }, form(EMAIL));

    expect(state).toEqual({ status: "sent" });
  });

  it("says so when the new link could not be sent", async () => {
    // The defect this covers: sign-up learned to admit a failed send, but the
    // page it sends those customers to did not. Someone told "we could not
    // send the confirmation email" would follow the link, ask for another,
    // and be told one was on its way -- while Resend rejected that one too.
    // Simulated at the send itself, so this exercises the real path:
    // hook -> recordDelivery -> takeDelivery -> state.
    await createAccount();
    sendVerificationEmail.mockResolvedValueOnce({ delivered: false });

    const state = await resendVerificationAction({ status: "idle" }, form(EMAIL));

    expect(state).toEqual({ status: "undelivered" });
  });

  it("stays silent about an address with no account", async () => {
    // No send is attempted, so there is no delivery record -- and `undefined`
    // must not be read as failure. If it were, this form would answer
    // "unknown address" differently from "address we mailed", which is the
    // enumeration oracle the silence exists to prevent.
    const state = await resendVerificationAction(
      { status: "idle" },
      form("nobody@example.com"),
    );

    expect(state).toEqual({ status: "sent" });
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("does not report a failure left behind by an earlier request", async () => {
    // takeDelivery consumes the record. A leftover `false` would make the
    // next, successful resend claim it had failed.
    await createAccount();
    sendVerificationEmail.mockResolvedValueOnce({ delivered: false });
    await resendVerificationAction({ status: "idle" }, form(EMAIL));

    const second = await resendVerificationAction({ status: "idle" }, form(EMAIL));

    expect(second).toEqual({ status: "sent" });
  });
});
