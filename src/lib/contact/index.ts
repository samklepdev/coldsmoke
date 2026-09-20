import { createHash } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { contactMessages } from "@/lib/db/schema";

/** Messages allowed from one address within the window. */
export const CONTACT_RATE_LIMIT = 5;

/**
 * Rolling, not a fixed calendar hour: a fixed window can be reset by waiting
 * for the boundary, which makes the limit close to decorative.
 */
export const CONTACT_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Rate limiting only needs to know whether two requests came from the same
 * place, which equality on a hash answers. Storing the raw address would keep
 * personal data this store has no use for.
 *
 * Salted so the hashes are not a plain rainbow-table lookup of the IPv4 space,
 * which is small enough to enumerate.
 */
export function hashIp(ip: string): string {
  const salt = process.env.CONTACT_IP_SALT ?? "coldsmoke-contact";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

export async function isRateLimited(ipHash: string): Promise<boolean> {
  const since = new Date(Date.now() - CONTACT_RATE_WINDOW_MS);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contactMessages)
    .where(
      and(eq(contactMessages.ipHash, ipHash), gte(contactMessages.createdAt, since)),
    );

  return (row?.count ?? 0) >= CONTACT_RATE_LIMIT;
}

/**
 * Written before the email is sent. A Resend outage then loses nothing, and
 * `deliveredAt` records whether the send actually landed.
 */
export async function recordMessage(input: {
  email: string;
  orderNumber?: number;
  message: string;
  ipHash: string;
}): Promise<{ id: string }> {
  const [row] = await db
    .insert(contactMessages)
    .values({
      email: input.email,
      orderNumber: input.orderNumber ?? null,
      message: input.message,
      ipHash: input.ipHash,
    })
    .returning({ id: contactMessages.id });

  return row;
}

export async function markDelivered(id: string): Promise<void> {
  await db
    .update(contactMessages)
    .set({ deliveredAt: new Date() })
    .where(eq(contactMessages.id, id));
}
