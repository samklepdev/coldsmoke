import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, stripeEvents, type Order } from "@/lib/db/schema";
import { getPayments } from "@/lib/payments";
import { OrderNotFoundForPaymentError } from "@/lib/orders";
import { OrderNotFoundError, OrderNotRefundableError } from "./errors";

/**
 * Asks Stripe for a refund. Writes nothing.
 *
 * The split from recordRefund below is deliberate: this moves money, that
 * moves status. One writer means a refund issued from the Stripe dashboard
 * lands exactly like one issued from admin -- both arrive as charge.refunded
 * and take the same path -- and the two can never disagree about an order.
 *
 * The idempotency key is stable for the same logical refund, so a double
 * submit returns the original refund rather than issuing a second one or
 * producing a raw Stripe rejection for an action that already worked.
 */
export async function refundOrder(args: {
  orderId: string;
}): Promise<{ refundId: string; amountCents: number }> {
  const [existing] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, args.orderId))
    .limit(1);

  if (!existing) throw new OrderNotFoundError(args.orderId);

  if (existing.status !== "paid" && existing.status !== "fulfilled") {
    throw new OrderNotRefundableError(args.orderId, `it is "${existing.status}"`);
  }

  if (!existing.stripePaymentIntentId) {
    throw new OrderNotRefundableError(args.orderId, "it has no payment intent");
  }

  const amountCents = existing.totalCents - existing.refundedCents;
  if (amountCents <= 0) {
    throw new OrderNotRefundableError(args.orderId, "it is already fully refunded");
  }

  const { refundId } = await getPayments().refund({
    paymentIntentId: existing.stripePaymentIntentId,
    amountCents,
    idempotencyKey: `refund:${existing.id}:${amountCents}`,
  });

  return { refundId, amountCents };
}

/**
 * The only path that sets status 'refunded'. Idempotent via the stripe_events
 * ledger, exactly like markOrderPaid -- a replayed webhook returns null.
 *
 * `refundedCents` is SET, never accumulated. Stripe reports amount_refunded
 * as the cumulative total for the charge, so two partial refunds of 1000 and
 * 1500 arrive as 1000 then 2500. Adding them yields 3500 and would wrongly
 * mark a half-refunded order as fully refunded.
 *
 * A partial refund leaves the status alone. There is no partially_refunded
 * state, and inventing one would cost a migration plus a new case in every
 * status filter; refundedCents already carries the fact.
 *
 * Fulfilment is not cleared. The parcel shipped, and erasing the carrier and
 * tracking number would destroy the record of it.
 */
export async function recordRefund(
  paymentIntentId: string,
  eventId: string,
  refundedCents: number,
): Promise<Order | null> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: eventId, type: "charge.refunded" })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });

    if (inserted.length === 0) return null; // Already processed.

    const [existing] = await tx
      .select()
      .from(orders)
      .where(eq(orders.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (!existing) {
      throw new OrderNotFoundForPaymentError(paymentIntentId);
    }

    const fullyRefunded = refundedCents >= existing.totalCents;

    const [order] = await tx
      .update(orders)
      .set(
        fullyRefunded
          ? { refundedCents, status: "refunded" as const }
          : { refundedCents },
      )
      .where(eq(orders.id, existing.id))
      .returning();

    return order ?? null;
  });
}
