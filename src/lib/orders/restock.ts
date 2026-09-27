import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, type Order } from "@/lib/db/schema";
import { restockOrderItems, RestockNotAllowedError } from "@/lib/inventory";

/**
 * Whether this order is waiting for someone to say what happened to its stock.
 *
 * Derived rather than stored. A boolean column would be a second source of
 * truth for something these two fields already answer, and the two could
 * disagree.
 */
export function awaitsStockDecision(order: Order): boolean {
  return order.refundedCents > 0 && order.stockDecisionAt === null;
}

/**
 * Returns units from a refunded order to stock and records that the decision
 * was made.
 *
 * Both happen in one transaction on purpose. An order stamped as decided with
 * nothing actually restocked would vanish from the pending list while its
 * units stayed lost -- the silent-drift failure this feature exists to end.
 */
export async function restockRefundedOrder(args: {
  orderId: string;
  lines: { orderItemId: string; quantity: number }[];
  adminUserId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await restockOrderItems(tx, args.orderId, args.lines, args.adminUserId);

    await tx
      .update(orders)
      .set({ stockDecisionAt: new Date() })
      .where(eq(orders.id, args.orderId));
  });
}

/**
 * Records that the goods are not coming back, without touching stock.
 *
 * Deliberately does not call restockOrderItems: there is nothing to restock,
 * and routing a zero through it would hit the "no units were entered" refusal.
 *
 * Takes no admin id because nothing here records one -- stock_decision_at
 * stores that a decision happened, not who made it, and the ledger only gets
 * rows for actual stock movements. Add attribution when there is a column to
 * put it in, not a parameter that goes nowhere.
 */
export async function writeOffOrderStock(args: {
  orderId: string;
}): Promise<void> {
  // Refuse when there is no refund to decide about. Without this, stamping an
  // unrefunded order looks harmless -- awaitsStockDecision already returns
  // false for it -- but it poisons the future: refund that order later and it
  // will never surface as awaiting a decision, so its units go back to nobody
  // and nothing says so. That is the silent drift this feature exists to end,
  // reintroduced through the back door.
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, args.orderId))
    .limit(1);

  if (!order) {
    throw new RestockNotAllowedError("no such order");
  }

  if (order.refundedCents <= 0) {
    throw new RestockNotAllowedError("it has no refund recorded");
  }

  await db
    .update(orders)
    .set({ stockDecisionAt: new Date() })
    .where(eq(orders.id, args.orderId));
}
