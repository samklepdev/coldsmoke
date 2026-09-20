"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

const schema = z.object({
  token: z.string().trim().min(1, "That reset link is incomplete."),
  password: z.string().min(8, "Use at least 8 characters."),
});

export type ResetState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "error"; error: string; fieldErrors?: Record<string, string> };

export async function resetPasswordAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const parsed = schema.safeParse({
    token: formData.get("token"),
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

  try {
    await auth.api.resetPassword({
      body: { newPassword: parsed.data.password, token: parsed.data.token },
      headers: await headers(),
    });
  } catch {
    // Expired, already spent, or forged all look the same from here, and the
    // customer's next move is identical in every case.
    return {
      status: "error",
      error: "That reset link has expired. Ask for a new one.",
    };
  }

  return { status: "ok" };
}
