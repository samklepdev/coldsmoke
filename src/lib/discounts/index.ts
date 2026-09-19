import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { discountCodes, type DiscountCode } from "@/lib/db/schema";

export * from "./validate";

/** Codes are stored and compared lowercase, so entry is case-insensitive. */
export async function lookupDiscount(
  rawCode: string,
): Promise<DiscountCode | null> {
  const normalized = rawCode.trim().toLowerCase();
  if (!normalized) return null;

  const [row] = await db
    .select()
    .from(discountCodes)
    .where(eq(discountCodes.code, normalized))
    .limit(1);

  return row ?? null;
}

/**
 * Increments redemption count, guarded by the cap so a race cannot exceed it.
 * Called from the webhook inside the same transaction that marks an order paid.
 *
 * Returns `true` when the row was updated, `false` when the cap was already
 * exhausted (the UPDATE matched zero rows). This runs after the customer has
 * already been charged and the order's stored total already reflects the
 * discount, so a `false` result means the discount was applied to an order
 * without being recorded here — the caller should log it, not throw: a throw
 * would fail the webhook and trigger Stripe retries for something that must
 * not block order fulfillment.
 */
export async function redeemDiscount(
  tx: Tx,
  discountCodeId: string,
): Promise<boolean> {
  const rows = await tx
    .update(discountCodes)
    .set({ timesRedeemed: sql`${discountCodes.timesRedeemed} + 1` })
    .where(
      sql`${discountCodes.id} = ${discountCodeId} AND (${discountCodes.maxRedemptions} IS NULL OR ${discountCodes.timesRedeemed} < ${discountCodes.maxRedemptions})`,
    )
    .returning({ id: discountCodes.id });

  return rows.length > 0;
}
