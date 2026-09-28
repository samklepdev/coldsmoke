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

/**
 * A date input submits "2099-01-01" with no timezone. Parsed as UTC midnight
 * so the same form produces the same instant wherever the admin happens to be.
 */
function parseDate(value: FormDataEntryValue | null): Date | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseOptionalInt(value: FormDataEntryValue | null): number | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

export async function createDiscountAction(
  _prev: DiscountAdminState,
  formData: FormData,
): Promise<DiscountAdminState> {
  await requireAdminUser();

  const type = formData.get("type") === "fixed" ? "fixed" : "percent";
  const rawValue = Number(String(formData.get("value") ?? "").trim());

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

  const endsAt = parseDate(formData.get("endsAt"));
  if (!endsAt) {
    return { status: "error", error: "Give the code an end date." };
  }

  try {
    const created = await createDiscountCode({
      code: String(formData.get("code") ?? ""),
      type,
      value,
      minSubtotalCents: Math.round(minSubtotalDollars * 100),
      maxRedemptions: parseOptionalInt(formData.get("maxRedemptions")),
      startsAt: parseDate(formData.get("startsAt")),
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
