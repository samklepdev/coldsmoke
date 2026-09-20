"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireSessionUser } from "@/lib/auth/session";
import { createAddress, deleteAddress, setDefaultAddress } from "@/lib/addresses";

const schema = z.object({
  label: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || null),
  name: z.string().trim().min(1, "Enter a name."),
  line1: z.string().trim().min(1, "Enter a street address."),
  line2: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || null),
  city: z.string().trim().min(1, "Enter a city."),
  state: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter state code.")
    .transform((v) => v.toUpperCase()),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a valid ZIP code."),
});

/**
 * `values` carries the submitted fields back to the form on an error.
 *
 * React resets an uncontrolled form once its action returns, so without this
 * a customer who mistypes one field -- a state code, say -- gets the whole
 * address blanked and has to type all six fields again. Measured on
 * 2026-09-20: the retry submitted empty fields and failed a second time for
 * a different reason, which is a maddening thing to happen to someone who
 * made one small mistake.
 */
export type AddressValues = Record<string, string>;

export type AddressState =
  | { status: "idle" }
  | { status: "saved" }
  | {
      status: "error";
      error: string;
      fieldErrors?: Record<string, string>;
      values?: AddressValues;
    };

export async function saveAddressAction(
  _prev: AddressState,
  formData: FormData,
): Promise<AddressState> {
  const user = await requireSessionUser("/account/addresses");

  const raw = Object.fromEntries(formData);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }

    const values: AddressValues = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") values[key] = value;
    }

    return {
      status: "error",
      error: "Check the highlighted fields.",
      fieldErrors,
      values,
    };
  }

  await createAddress(user.id, parsed.data);
  revalidatePath("/account/addresses");
  return { status: "saved" };
}

export async function deleteAddressAction(formData: FormData): Promise<void> {
  const user = await requireSessionUser("/account/addresses");
  const id = String(formData.get("id") ?? "");
  // The session's user id, never one from the form: the id in the form is
  // attacker-controlled, the session is not.
  await deleteAddress(user.id, id);
  revalidatePath("/account/addresses");
}

export async function setDefaultAddressAction(formData: FormData): Promise<void> {
  const user = await requireSessionUser("/account/addresses");
  const id = String(formData.get("id") ?? "");
  await setDefaultAddress(user.id, id);
  revalidatePath("/account/addresses");
}
