"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

const schema = z.object({ email: z.email("Enter a valid email address.") });

export type ResendState =
  | { status: "idle" }
  | { status: "sent" }
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

  return { status: "sent" };
}
