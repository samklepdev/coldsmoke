"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

const schema = z.object({ email: z.email("Enter a valid email address.") });

export type ForgotState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "error"; error: string };

export async function requestResetAction(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const parsed = schema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { status: "error", error: "Enter a valid email address." };
  }

  try {
    await auth.api.requestPasswordReset({
      body: { email: parsed.data.email, redirectTo: "/reset-password" },
      headers: await headers(),
    });
  } catch {
    // Same answer either way -- see below.
  }

  // Unknown addresses get this too. A "no account with that address" message
  // would tell an attacker which of their stolen addresses shop here, and the
  // person who genuinely mistyped theirs finds out when no email arrives.
  return { status: "sent" };
}
