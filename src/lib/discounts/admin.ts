import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { discountCodes, type DiscountCode } from "@/lib/db/schema";

export class DiscountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscountInputError";
  }
}

export type CreateDiscountInput = {
  code: string;
  type: "percent" | "fixed";
  /** 1-100 for percent, cents for fixed. */
  value: number;
  minSubtotalCents: number;
  maxRedemptions: number | null;
  startsAt: Date | null;
  /** Required here even though the column is nullable -- see below. */
  endsAt: Date;
};

/** Postgres unique-violation. */
function isDuplicate(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  // postgres-js wraps the driver error as DrizzleQueryError, with the actual
  // PostgresError (and its `code`) on `.cause` rather than the error itself.
  if ("code" in error && (error as { code: unknown }).code === "23505") {
    return true;
  }
  const cause = "cause" in error ? (error as { cause: unknown }).cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code: unknown }).code === "23505"
  );
}

/**
 * Creates a code the existing redemption path can use.
 *
 * An end date is required, though the column is nullable and stays that way.
 * A promotion with no expiry and no cap is unbounded liability whose only
 * stopping mechanism is somebody noticing; being stricter than the schema is
 * the point. Existing rows and the customer-facing path are untouched.
 */
export async function createDiscountCode(
  input: CreateDiscountInput,
): Promise<DiscountCode> {
  const code = input.code.trim().toLowerCase();

  if (!code) {
    throw new DiscountInputError("Enter a code.");
  }
  if (!/^[a-z0-9-]+$/.test(code)) {
    throw new DiscountInputError(
      "Codes can use letters, numbers and hyphens only.",
    );
  }
  if (!input.endsAt) {
    throw new DiscountInputError("Give the code an end date.");
  }
  if (input.startsAt && input.startsAt >= input.endsAt) {
    throw new DiscountInputError("The end date must be after the start date.");
  }
  if (!Number.isInteger(input.value) || input.value <= 0) {
    throw new DiscountInputError("Enter a whole amount above zero.");
  }
  if (input.type === "percent" && input.value > 100) {
    throw new DiscountInputError("A percentage cannot be above 100.");
  }
  if (!Number.isInteger(input.minSubtotalCents) || input.minSubtotalCents < 0) {
    throw new DiscountInputError("The minimum cannot be negative.");
  }
  if (
    input.maxRedemptions !== null &&
    (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1)
  ) {
    throw new DiscountInputError("A redemption cap must be at least 1.");
  }

  try {
    const [row] = await db
      .insert(discountCodes)
      .values({
        code,
        type: input.type,
        value: input.value,
        minSubtotalCents: input.minSubtotalCents,
        maxRedemptions: input.maxRedemptions,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      })
      .returning();

    return row;
  } catch (error) {
    // Caught from the unique index rather than a pre-read: a read-then-insert
    // can lose the race, the constraint cannot.
    if (isDuplicate(error)) {
      throw new DiscountInputError("That code already exists.");
    }
    throw error;
  }
}

/**
 * Every code, newest first -- the one you just made is the one you are
 * looking for.
 *
 * Ordered by createdAt, never by id: `id` is a random v4 uuid, so `desc(id)`
 * is arbitrary rather than chronological. It reads as newest-first and is not,
 * which is exactly how it survived a browser check.
 *
 * Tie-broken by code because every row predating the created_at column shares
 * the migration's timestamp, making ties the normal case on an existing
 * database; without it their order is whatever Postgres happens to return.
 */
export async function listDiscountCodes(): Promise<DiscountCode[]> {
  return db
    .select()
    .from(discountCodes)
    .orderBy(desc(discountCodes.createdAt), desc(discountCodes.code));
}

/**
 * Switches a code off. Never deletes: orders.discount_code_id references it
 * forever, and a deleted row would orphan the record of what a customer was
 * actually charged.
 */
export async function deactivateDiscountCode(id: string): Promise<void> {
  await db
    .update(discountCodes)
    .set({ active: false })
    .where(eq(discountCodes.id, id));
}
