"use server";

import { z } from "zod";
import { headers } from "next/headers";
import {
  hashIp,
  isRateLimited,
  recordMessage,
  markDelivered,
} from "@/lib/contact";
import { getResend } from "@/lib/email/client";
import { BUSINESS } from "@/lib/business";

const schema = z.object({
  email: z.email("Enter a valid email address."),
  // Optional: an untouched input still posts "", which must not become 0.
  orderNumber: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? Number(value) : undefined))
    .refine((value) => value === undefined || Number.isInteger(value), {
      message: "Order numbers are digits only.",
    }),
  message: z
    .string()
    .trim()
    .min(10, "Tell us a little more.")
    .max(4000, "That is too long to send. Email us instead."),
});

export type ContactState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "error"; error: string; fieldErrors?: Record<string, string> };

export async function sendContactMessage(
  _prev: ContactState,
  formData: FormData,
): Promise<ContactState> {
  // A bot that fills every field trips this. Returning the same success state
  // as a real send means it learns nothing about why it failed -- and nothing
  // is stored or sent.
  if ((formData.get("website") as string)?.trim()) {
    return { status: "sent" };
  }

  const parsed = schema.safeParse({
    email: formData.get("email"),
    orderNumber: formData.get("orderNumber"),
    message: formData.get("message"),
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

  const headerList = await headers();
  // x-forwarded-for is a list; the client is the first entry.
  const ip =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const ipHash = hashIp(ip);

  if (await isRateLimited(ipHash)) {
    // Told plainly rather than silently dropped: a customer who hits this
    // legitimately needs to know the message did not go through.
    return {
      status: "error",
      error: "Too many messages from here. Try again in an hour.",
    };
  }

  // Stored first. If Resend is down the message still exists and can be sent
  // later; the customer is not asked to retype it.
  const { id } = await recordMessage({
    email: parsed.data.email,
    orderNumber: parsed.data.orderNumber,
    message: parsed.data.message,
    ipHash,
  });

  try {
    await getResend().emails.send({
      from: "Coldsmoke <noreply@wearcoldsmoke.com>",
      to: BUSINESS.supportEmail,
      replyTo: parsed.data.email,
      subject: parsed.data.orderNumber
        ? `Contact — order ${parsed.data.orderNumber}`
        : "Contact — general",
      text: parsed.data.message,
    });
    await markDelivered(id);
  } catch (err) {
    // The message IS received -- it is in the database. Telling the customer
    // otherwise would prompt them to send it again.
    console.error("[contact] stored but not delivered", { id, cause: err });
  }

  return { status: "sent" };
}
