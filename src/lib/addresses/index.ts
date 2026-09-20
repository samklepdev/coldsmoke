import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { addresses, type SavedAddress } from "@/lib/db/schema";

export type { SavedAddress };

export type AddressInput = {
  label?: string | null;
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  phone?: string | null;
};

/**
 * Every function here takes userId as its first argument and filters on it.
 *
 * That is the whole ownership model: an address id is a uuid a caller could
 * supply from anywhere, so no function may act on one without also matching
 * the owner. The "refuses to ... belonging to someone else" tests are the
 * ones that would fail if a future edit drops that condition.
 */
export async function listAddresses(userId: string): Promise<SavedAddress[]> {
  return db
    .select()
    .from(addresses)
    .where(eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), asc(addresses.createdAt));
}

export async function createAddress(
  userId: string,
  input: AddressInput,
): Promise<SavedAddress> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: addresses.id })
      .from(addresses)
      .where(eq(addresses.userId, userId))
      .limit(1);

    const [created] = await tx
      .insert(addresses)
      .values({
        userId,
        label: input.label ?? null,
        name: input.name,
        line1: input.line1,
        line2: input.line2 ?? null,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country ?? "US",
        phone: input.phone ?? null,
        // The first address a customer saves is their default; anything else
        // leaves checkout with nothing to preselect.
        isDefault: existing.length === 0,
      })
      .returning();

    return created;
  });
}

export async function deleteAddress(
  userId: string,
  addressId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
    .returning({ id: addresses.id });

  return deleted.length > 0;
}

export async function setDefaultAddress(
  userId: string,
  addressId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Clear first: the partial unique index permits only one default per
    // customer, so promoting before demoting would violate it.
    await tx
      .update(addresses)
      .set({ isDefault: false })
      .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)));

    const promoted = await tx
      .update(addresses)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
      .returning({ id: addresses.id });

    return promoted.length > 0;
  });
}
