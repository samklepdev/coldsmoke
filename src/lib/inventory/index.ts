import { and, eq, lt, sql } from "drizzle-orm";
import { db, type Db, type Tx } from "@/lib/db/client";
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

/**
 * Returns reserved units to the available pool. Idempotent.
 *
 * @returns true if the reservation was actually released (the order was
 *   still in the "reserved" inventory state), false if there was nothing to
 *   do — e.g. the order was already committed or released by another
 *   caller. Callers that conditionally act on the release (such as
 *   cancelling the order) must check this before doing so.
 */
export async function releaseStock(tx: Tx, orderId: string): Promise<boolean> {
  const claimed = await claimInventoryState(tx, orderId, "reserved", "released");
  if (!claimed) return false;

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

  return true;
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
 *
 * The candidate list is selected outside any transaction, so an order can
 * change state (e.g. a Stripe webhook committing it to "paid") in the gap
 * between that SELECT and this function reaching it. Each order is therefore
 * only cancelled if `releaseStock` actually released it — and the status
 * write is additionally guarded on `status = "pending"` as a second line of
 * defence, so a stale candidate can never clobber a non-pending order.
 */
export async function releaseExpiredReservations(database: Db = db): Promise<number> {
  const expired = await database
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "pending"),
        eq(orders.inventoryState, "reserved"),
        lt(orders.reservationExpiresAt, new Date()),
      ),
    );

  let cancelledCount = 0;

  for (const order of expired) {
    await database.transaction(async (tx) => {
      const released = await releaseStock(tx, order.id);
      if (!released) return;

      const cancelled = await tx
        .update(orders)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
        .returning({ id: orders.id });

      if (cancelled.length > 0) cancelledCount++;
    });
  }

  return cancelledCount;
}
