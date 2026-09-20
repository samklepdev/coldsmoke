"use server";

import { z } from "zod";
import { headers } from "next/headers";
import {
  hashIp,
  isRateLimited,
  recordMessage,
  markDelivered,
} from "@/lib/contact";
import { getResend, EMAIL_FROM } from "@/lib/email/client";
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
    // Resend reports API failures by RETURNING an error, not by throwing: a
    // rejected address comes back as { data: null, error: {...} } with a 422.
    // Measured on 2026-09-20 against the real API. So the catch below only
    // covers network-level throws, and `error` has to be checked explicitly --
    // otherwise deliveredAt would be set for mail that was never accepted,
    // which is the one thing this column exists to tell us apart.
    const { error } = await getResend().emails.send({
      // EMAIL_FROM, not a literal: Resend rejects any sending domain that is
      // not verified, so a hardcoded address here silently stops matching the
      // one domain that was set up. `replyTo` below is what actually carries
      // the conversation back to the customer, so the From only needs to be
      // ours and deliverable.
      from: EMAIL_FROM,
      to: BUSINESS.supportEmail,
      replyTo: parsed.data.email,
      subject: parsed.data.orderNumber
        ? `Contact — order ${parsed.data.orderNumber}`
        : "Contact — general",
      text: parsed.data.message,
    });

    if (error) {
      console.error("[contact] stored but not delivered", { id, cause: error });
    } else {
      await markDelivered(id);
    }
  } catch (err) {
    // The message IS received -- it is in the database. Telling the customer
    // otherwise would prompt them to send it again.
    console.error("[contact] stored but not delivered", { id, cause: err });
  }

  return { status: "sent" };
}
