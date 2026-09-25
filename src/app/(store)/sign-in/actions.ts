"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { mergeGuestCart } from "@/lib/cart/merge";

const schema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export type SignInState =
  | { status: "idle" }
  | { status: "ok" }
  | { status: "unverified"; email: string }
  | { status: "error"; error: string };

export async function signInAction(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { status: "error", error: "That email and password do not match." };
  }

  let userId: string;
  try {
    const result = await auth.api.signInEmail({
      body: parsed.data,
      headers: await headers(),
    });
    userId = result.user.id;
  } catch (err) {
    if (
      err instanceof APIError &&
      err.body?.code === auth.$ERROR_CODES.EMAIL_NOT_VERIFIED.code
    ) {
      return { status: "unverified", email: parsed.data.email };
    }

    // One message for "no such account" and for "wrong password". Telling
    // them apart would turn this form into a list of who shops here.
    return { status: "error", error: "That email and password do not match." };
  }

  // Only after a real sign-in. A guest cart must never be merged into an
  // account that failed to authenticate.
  await mergeGuestCart(userId);

  return { status: "ok" };
}
