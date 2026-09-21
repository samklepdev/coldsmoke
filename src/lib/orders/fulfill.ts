import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, type Order } from "@/lib/db/schema";
import { OrderNotFoundError, OrderNotFulfillableError } from "./errors";

/**
 * The only path that sets status 'fulfilled'.
 *
 * The order is re-read inside the transaction rather than trusted from the
 * page that submitted: an admin tab can sit open across a refund, and the
 * status it rendered may no longer be true. The same status is repeated in
 * the UPDATE's WHERE clause so two concurrent submits cannot both win --
 * the loser updates zero rows and is reported as unfulfillable rather than
 * silently overwriting the first parcel's tracking number.
 */
export async function fulfillOrder(args: {
  orderId: string;
  carrier: string;
  trackingNumber: string;
}): Promise<Order> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, args.orderId))
      .limit(1);

    if (!existing) throw new OrderNotFoundError(args.orderId);

    if (existing.status !== "paid") {
      throw new OrderNotFulfillableError(args.orderId, existing.status);
    }

    const [order] = await tx
      .update(orders)
      .set({
        status: "fulfilled",
        carrier: args.carrier,
        trackingNumber: args.trackingNumber,
        fulfilledAt: new Date(),
      })
      .where(and(eq(orders.id, args.orderId), eq(orders.status, "paid")))
      .returning();

    if (!order) {
      throw new OrderNotFulfillableError(args.orderId, "paid, then changed");
    }

    return order;
  });
}
