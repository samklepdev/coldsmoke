import { and, eq, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { inventory, orders, orderItems } from "@/lib/db/schema";

export const RESERVATION_WINDOW_MS = 15 * 60 * 1000;

export class OutOfStockError extends Error {
  constructor(public readonly productId: string) {
    super(`Out of stock: ${productId}`);
    this.name = "OutOfStockError";
  }
}

/**
 * Reserves stock for a set of lines. The guard lives in the WHERE clause, so
 * Postgres decides the winner of a race between two buyers — the read and the
 * write are one atomic statement, with no gap to lose.
 *
 * Must be called inside a transaction: a failure on any line rolls back the
 * reservations already made for earlier lines.
 */
export async function reserveStock(
  tx: Tx,
  items: { productId: string; quantity: number }[],
): Promise<void> {
  for (const item of items) {
    const updated = await tx
      .update(inventory)
      .set({
        reserved: sql`${inventory.reserved} + ${item.quantity}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventory.productId, item.productId),
          sql`${inventory.onHand} - ${inventory.reserved} >= ${item.quantity}`,
        ),
      )
      .returning({ productId: inventory.productId });

    if (updated.length === 0) {
      throw new OutOfStockError(item.productId);
    }
  }
}

/**
 * Converts a reservation into a sale. Guarded on inventoryState so a replayed
 * Stripe webhook cannot decrement stock twice.
 */
export async function commitStock(tx: Tx, orderId: string): Promise<void> {
  const claimed = await claimInventoryState(tx, orderId, "reserved", "committed");
  if (!claimed) return;

  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  for (const item of items) {
    await tx
      .update(inventory)
      .set({
        onHand: sql`${inventory.onHand} - ${item.quantity}`,
        reserved: sql`GREATEST(${inventory.reserved} - ${item.quantity}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(inventory.productId, item.productId));
  }
}

/** Returns reserved units to the available pool. Idempotent. */
export async function releaseStock(tx: Tx, orderId: string): Promise<void> {
  const claimed = await claimInventoryState(tx, orderId, "reserved", "released");
  if (!claimed) return;

  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  for (const item of items) {
    await tx
      .update(inventory)
      .set({
        reserved: sql`GREATEST(${inventory.reserved} - ${item.quantity}, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(inventory.productId, item.productId));
  }
}

/**
 * Atomically moves an order from one inventory state to another. Returns false
 * if the order was not in the expected state, which is how idempotency is
 * enforced: the second caller finds nothing to claim and does nothing.
 */
async function claimInventoryState(
  tx: Tx,
  orderId: string,
  from: "reserved",
  to: "committed" | "released",
): Promise<boolean> {
  const rows = await tx
    .update(orders)
    .set({ inventoryState: to })
    .where(and(eq(orders.id, orderId), eq(orders.inventoryState, from)))
    .returning({ id: orders.id });

  return rows.length > 0;
}

/**
 * Releases reservations for pending orders past their expiry window, so an
 * abandoned checkout does not hold a bottle forever. Called by the cron route
 * and lazily before reservation-sensitive reads.
 */
export async function releaseExpiredReservations(): Promise<number> {
  const expired = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "pending"),
        eq(orders.inventoryState, "reserved"),
        lt(orders.reservationExpiresAt, new Date()),
      ),
    );

  for (const order of expired) {
    await db.transaction(async (tx) => {
      await releaseStock(tx, order.id);
      await tx
        .update(orders)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(eq(orders.id, order.id));
    });
  }

  return expired.length;
}
