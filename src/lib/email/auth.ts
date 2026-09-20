import { getResend, EMAIL_FROM } from "./client";

/**
 * The two transactional emails the auth flow depends on.
 *
 * Bodies are built by pure functions so their wording is testable without a
 * network call, and so the link they contain can be asserted directly.
 */

export function verificationEmail(url: string): { subject: string; text: string } {
  return {
    subject: "Verify your email address",
    text: [
      "Confirm this address to finish setting up your Coldsmoke account:",
      "",
      url,
      "",
      "If you did not create an account, you can ignore this message.",
    ].join("\n"),
  };
}

export function passwordResetEmail(url: string): { subject: string; text: string } {
  return {
    subject: "Reset your Coldsmoke password",
    text: [
      "Use this link to choose a new password:",
      "",
      url,
      "",
      "If you did not request a password reset, ignore this message and your",
      "password will stay as it is.",
    ].join("\n"),
  };
}

/**
 * Never throws, and never reports a delivery that did not happen.
 *
 * Both halves matter. Better Auth calls this from inside its own request
 * handling, so a throw becomes a 500 on a sign-up that actually succeeded.
 * And Resend signals a rejected address by RETURNING { data: null, error }
 * with a 422 rather than throwing, so the returned error has to be inspected
 * explicitly -- a try/catch alone reports success for mail nobody received.
 */
async function send(args: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ delivered: boolean }> {
  try {
    const { error } = await getResend().emails.send({
      from: EMAIL_FROM,
      to: args.to,
      subject: args.subject,
      text: args.text,
    });

    if (error) {
      console.error("[email] auth mail rejected", { subject: args.subject, cause: error });
      return { delivered: false };
    }

    return { delivered: true };
  } catch (cause) {
    console.error("[email] auth mail threw", { subject: args.subject, cause });
    return { delivered: false };
  }
}

export function sendVerificationEmail(args: {
  to: string;
  url: string;
}): Promise<{ delivered: boolean }> {
  return send({ to: args.to, ...verificationEmail(args.url) });
}

export function sendPasswordResetEmail(args: {
  to: string;
  url: string;
}): Promise<{ delivered: boolean }> {
  return send({ to: args.to, ...passwordResetEmail(args.url) });
}
