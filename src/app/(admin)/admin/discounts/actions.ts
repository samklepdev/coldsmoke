"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdminUser } from "@/lib/auth/session";
import {
  createDiscountCode,
  deactivateDiscountCode,
  DiscountInputError,
} from "@/lib/discounts/admin";

export type DiscountAdminState =
  | { status: "idle" }
  | { status: "created"; code: string }
  | { status: "deactivated" }
  | { status: "error"; error: string };

type ParsedDate =
  | { kind: "blank" }
  | { kind: "invalid" }
  | { kind: "valid"; date: Date };

/**
 * A date input submits "YYYY-MM-DD" with no timezone. Parsed as UTC so the
 * same form produces the same instant wherever the admin happens to be.
 *
 * Start and end are anchored to opposite ends of that day: a start reads as
 * "no earlier than this day" (UTC midnight), but an end reads as "through
 * the end of this day" (23:59:59.999 UTC). Anchoring endsAt at midnight
 * would make "ends today" already hours in the past for an admin behind
 * UTC -- this shop is run from Houston, UTC-5/6 -- so the code would be dead
 * on arrival while the UI implied it was valid through today.
 *
 * `new Date("2099-02-30T...")` does not produce Invalid Date; it silently
 * rolls over to March 2nd. The shape is checked strictly and the
 * constructed date's UTC year/month/day are compared back against what was
 * submitted so a malformed date is refused rather than quietly corrected.
 */
function parseDate(
  value: FormDataEntryValue | null,
  boundary: "start" | "end",
): ParsedDate {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { kind: "blank" };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { kind: "invalid" };

  const time = boundary === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z";
  const date = new Date(`${raw}${time}`);
  if (Number.isNaN(date.getTime())) return { kind: "invalid" };

  const [year, month, day] = raw.split("-").map(Number);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return { kind: "invalid" };
  }

  return { kind: "valid", date };
}

type ParsedCount =
  | { kind: "blank" }
  | { kind: "invalid" }
  | { kind: "valid"; count: number };

/**
 * Blank legitimately means "no cap". Unparseable input must NOT collapse into
 * that same meaning -- returning null for "2.5" or "abc" turns a typo into an
 * uncapped promotion, the unbounded liability the required end date exists to
 * prevent. Refused rather than defaulted, like `type`, and for the same
 * reason: a Server Action is reachable by POST without the form rendering.
 *
 * Out-of-range whole numbers (0, -5) are deliberately passed through: they
 * parse fine and createDiscountCode refuses them with a specific message.
 */
function parseCount(value: FormDataEntryValue | null): ParsedCount {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { kind: "blank" };

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return { kind: "invalid" };

  return { kind: "valid", count: parsed };
}

export async function createDiscountAction(
  _prev: DiscountAdminState,
  formData: FormData,
): Promise<DiscountAdminState> {
  await requireAdminUser();

  const rawType = formData.get("type");
  if (rawType !== "percent" && rawType !== "fixed") {
    // A Server Action is reachable by POST without the form ever rendering,
    // so a missing or tampered type is refused rather than defaulted.
    return { status: "error", error: "Choose a discount type." };
  }
  const type = rawType;

  const rawValueStr = String(formData.get("value") ?? "").trim();
  if (rawValueStr === "") {
    // Number("") is 0 and Number.isFinite(0) is true, so blank has to be
    // caught before the numeric check runs -- otherwise an empty value
    // field silently creates a 0%-off or $0.00 code.
    return { status: "error", error: "Enter an amount." };
  }
  const rawValue = Number(rawValueStr);

  if (!Number.isFinite(rawValue)) {
    return { status: "error", error: "Enter an amount." };
  }

  // Percent is entered as a whole number; fixed is entered in dollars and
  // stored in cents, like every other money column in this schema.
  const value = type === "fixed" ? Math.round(rawValue * 100) : rawValue;

  const minSubtotalDollars = Number(
    String(formData.get("minSubtotal") ?? "0").trim() || "0",
  );
  if (!Number.isFinite(minSubtotalDollars) || minSubtotalDollars < 0) {
    return { status: "error", error: "Enter a minimum of zero or more." };
  }

  const endsAtParsed = parseDate(formData.get("endsAt"), "end");
  if (endsAtParsed.kind === "blank") {
    return { status: "error", error: "Give the code an end date." };
  }
  if (endsAtParsed.kind === "invalid") {
    return { status: "error", error: "Enter a valid end date." };
  }
  const endsAt = endsAtParsed.date;

  const startsAtParsed = parseDate(formData.get("startsAt"), "start");
  if (startsAtParsed.kind === "invalid") {
    return { status: "error", error: "Enter a valid start date." };
  }
  // Blank legitimately means "no start restriction"; garbled input does not
  // fall through to that same meaning -- it is refused above.
  const startsAt = startsAtParsed.kind === "valid" ? startsAtParsed.date : null;

  const capParsed = parseCount(formData.get("maxRedemptions"));
  if (capParsed.kind === "invalid") {
    return {
      status: "error",
      error: "Enter a whole number of redemptions, or leave it blank.",
    };
  }
  const maxRedemptions = capParsed.kind === "valid" ? capParsed.count : null;

  try {
    const created = await createDiscountCode({
      code: String(formData.get("code") ?? ""),
      type,
      value,
      minSubtotalCents: Math.round(minSubtotalDollars * 100),
      maxRedemptions,
      startsAt,
      endsAt,
    });

    revalidatePath("/admin/discounts");
    return { status: "created", code: created.code };
  } catch (error) {
    if (error instanceof DiscountInputError) {
      return { status: "error", error: error.message };
    }
    throw error;
  }
}

export async function deactivateDiscountAction(
  _prev: DiscountAdminState,
  formData: FormData,
): Promise<DiscountAdminState> {
  await requireAdminUser();

  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) {
    return { status: "error", error: "Unknown code." };
  }

  await deactivateDiscountCode(id.data);

  revalidatePath("/admin/discounts");
  return { status: "deactivated" };
}
