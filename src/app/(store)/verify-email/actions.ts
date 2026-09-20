"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { takeDelivery } from "@/lib/email/delivery";

const schema = z.object({ email: z.email("Enter a valid email address.") });

export type ResendState =
  | { status: "idle" }
  | { status: "sent" }
  /** A send was attempted for a real account and Resend rejected it. */
  | { status: "undelivered" }
  | { status: "error"; error: string };

export async function resendVerificationAction(
  _prev: ResendState,
  formData: FormData,
): Promise<ResendState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { status: "error", error: "Enter a valid email address." };
  }

  try {
    await auth.api.sendVerificationEmail({
      body: { email: parsed.data.email, callbackURL: "/sign-in?verified=1" },
      headers: await headers(),
    });
  } catch {
    // Swallowed on purpose. The failure modes here are "no such account" and
    // "already verified", and reporting either would turn this form into the
    // enumeration oracle the sign-up form deliberately is not.
  }

  /**
   * The one thing worth breaking that silence for: mail we tried and failed
   * to send.
   *
   * `undefined` is the silence above -- no send was attempted, because the
   * address has no account or is already verified -- and it stays "sent".
   * Only an explicit `false` is reported, which means an account exists and
   * Resend rejected the message. So this says nothing about any address until
   * our own mail is broken, and staying quiet then would strand the customer
   * on the page we send them to precisely because a send already failed.
   */
  if (takeDelivery(parsed.data.email) === false) {
    return { status: "undelivered" };
  }

  return { status: "sent" };
}
