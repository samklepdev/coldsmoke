"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

const schema = z.object({
  name: z.string().trim().min(1, "Enter your name."),
  email: z.email("Enter a valid email address."),
  // Matches minPasswordLength in the auth config. Checked here too so the
  // customer gets a field-level message instead of a thrown APIError.
  password: z.string().min(8, "Use at least 8 characters."),
});

export type SignUpState =
  | { status: "idle" }
  | { status: "sent"; email: string }
  | { status: "error"; error: string; fieldErrors?: Record<string, string> };

export async function signUpAction(
  _prev: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  const parsed = schema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    return { status: "error", error: "Check the highlighted fields.", fieldErrors };
  }

  const { name, email, password } = parsed.data;

  /**
   * No "that address is taken" branch here, deliberately, and none is needed.
   *
   * Because the auth config sets `requireEmailVerification`, Better Auth
   * answers a duplicate sign-up with a fabricated success response instead of
   * throwing: nothing is written, no error is raised, and the browser cannot
   * distinguish a taken address from a free one. Verified against 1.7.5 on
   * 2026-09-20 -- an earlier draft of this action caught
   * USER_ALREADY_EXISTS, and that catch was simply dead code.
   *
   * The real account holder is notified from `onExistingUserSignUp` in the
   * auth config, which is the hook Better Auth provides for it.
   */
  await auth.api.signUpEmail({
    body: { name, email, password },
    headers: await headers(),
  });

  return { status: "sent", email };
}
