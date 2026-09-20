import { and, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders } from "@/lib/db/schema";

/**
 * Attaches a verified customer's past guest orders to their account.
 *
 * Called only from Better Auth's afterEmailVerification hook. An email
 * address is a claim until it is verified; running this at sign-up would let
 * anyone type a stranger's address and read that stranger's order history.
 *
 * `isNull(orders.userId)` is not an optimisation. It is what stops a second
 * account claiming an order that already belongs to a first -- two people can
 * legitimately have used the same address at a shared household, and the
 * earlier claim wins.
 */
export async function claimGuestOrders(args: {
  userId: string;
  email: string;
}): Promise<number> {
  const claimed = await db
    .update(orders)
    .set({ userId: args.userId })
    .where(
      and(
        isNull(orders.userId),
        // Checkout stores the address exactly as typed; Better Auth
        // lowercases it. Compare on equal terms.
        sql`lower(${orders.email}) = ${args.email.toLowerCase()}`,
      ),
    )
    .returning({ id: orders.id });

  return claimed.length;
}
