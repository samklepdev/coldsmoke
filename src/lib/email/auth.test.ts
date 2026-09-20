import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("./client", () => ({
  getResend: () => ({ emails: { send: sendMock } }),
  EMAIL_FROM: "Coldsmoke <orders@wearcoldsmoke.com>",
}));

const {
  verificationEmail,
  passwordResetEmail,
  existingAccountEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
} = await import("./auth");

beforeEach(() => {
  sendMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const URL = "https://wearcoldsmoke.com/api/auth/verify-email?token=abc";

describe("email bodies", () => {
  it("puts the verification link in the body", () => {
    expect(verificationEmail(URL).text).toContain(URL);
  });

  it("says what the verification email is for", () => {
    expect(verificationEmail(URL).subject).toBe("Verify your email address");
  });

  it("puts the reset link in the body", () => {
    expect(passwordResetEmail(URL).text).toContain(URL);
  });

  it("says what the reset email is for", () => {
    expect(passwordResetEmail(URL).subject).toBe("Reset your Coldsmoke password");
  });

  it("tells a reset recipient what to do if they did not ask", () => {
    // A password-reset mail that arrives unrequested is the one signal a
    // customer gets that someone is trying to get into their account.
    expect(passwordResetEmail(URL).text.toLowerCase()).toContain("did not request");
  });

  it("puts the sign-in link in the existing-account body", () => {
    expect(existingAccountEmail(URL).text).toContain(URL);
  });

  it("says what the existing-account email is for", () => {
    expect(existingAccountEmail(URL).subject).toBe(
      "You already have a Coldsmoke account",
    );
  });

  it("does not confirm the account to a stranger who guessed the address", () => {
    // This mail goes to the real owner, not to whoever submitted the form, so
    // it may say the account exists. What it must never do is imply the
    // sign-up attempt revealed anything.
    expect(existingAccountEmail(URL).text).toContain("Nobody");
  });
});

describe("sending", () => {
  it("reports delivery when Resend accepts the message", async () => {
    sendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });

    expect(await sendVerificationEmail({ to: "b@example.com", url: URL })).toEqual({
      delivered: true,
    });
  });

  /**
   * The failure Resend actually produces. It returns an error object with a
   * 422 rather than throwing, so a bare try/catch reports success for mail
   * that was rejected. Measured against the live API on 2026-09-20.
   */
  it("reports failure when Resend returns an error instead of throwing", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { statusCode: 422, name: "validation_error", message: "Invalid `to` field." },
    });

    expect(await sendPasswordResetEmail({ to: "nonsense", url: URL })).toEqual({
      delivered: false,
    });
  });

  it("reports failure when the call throws outright", async () => {
    sendMock.mockRejectedValue(new Error("socket hang up"));

    expect(await sendVerificationEmail({ to: "b@example.com", url: URL })).toEqual({
      delivered: false,
    });
  });

  it("never lets a send failure escape to the caller", async () => {
    // Better Auth calls these from inside its own request handling. A throw
    // here surfaces to the customer as a 500 on a sign-up that actually
    // succeeded, and they cannot tell the difference from a failed one.
    sendMock.mockRejectedValue(new Error("socket hang up"));

    await expect(
      sendPasswordResetEmail({ to: "b@example.com", url: URL }),
    ).resolves.toBeDefined();
  });
});
