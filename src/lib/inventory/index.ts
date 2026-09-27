import { and, eq, lt, sql } from "drizzle-orm";
import { db, type Db, type Tx } from "@/lib/db/client";
import {
  inventory,
  inventoryAdjustments,
  orders,
  orderItems,
} from "@/lib/db/schema";

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

export class RestockNotAllowedError extends Error {
  constructor(reason: string) {
    super(`Cannot restock this order: ${reason}`);
    this.name = "RestockNotAllowedError";
  }
}

/**
 * Returns refunded units to the available pool.
 *
 * Refunding an order used to move money and nothing else, so every refund
 * quietly destroyed stock on paper: `commitStock` had already decremented
 * `on_hand`, and nothing ever added it back.
 *
 * The bound lives in the WHERE clause, like `reserveStock`'s. That single
 * atomic statement is the whole idempotency story -- a double-submitted form
 * or two admins clicking at once cannot inflate stock, and no lock is needed.
 * Unlike a state-machine claim it still allows a LATER return of whatever is
 * left, which is the second-bottle-comes-back-next-week case.
 *
 * `reserved` is deliberately untouched: this order's reservation was consumed
 * when its stock was committed, and putting units back there would make them
 * look spoken-for by an order that no longer exists.
 *
 * Must be called inside a transaction: a failure on any line must roll back
 * the lines already restocked, or a partial failure leaves invented stock.
 */
export async function restockOrderItems(
  tx: Tx,
  orderId: string,
  lines: { orderItemId: string; quantity: number }[],
  adminUserId: string,
): Promise<void> {
  const requested = lines.filter((line) => line.quantity > 0);
  if (requested.length === 0) {
    throw new RestockNotAllowedError(
      "no units were entered — write the order off instead if nothing came back",
    );
  }

  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) {
    throw new RestockNotAllowedError("no such order");
  }

  // Units that were never deducted cannot be returned; doing so would invent
  // stock out of nothing.
  if (order.inventoryState !== "committed") {
    throw new RestockNotAllowedError(
      `its stock was never committed (inventory state "${order.inventoryState}")`,
    );
  }

  if (order.refundedCents <= 0) {
    throw new RestockNotAllowedError("it has no refund recorded");
  }

  for (const line of requested) {
    const claimed = await tx
      .update(orderItems)
      .set({
        restockedQuantity: sql`${orderItems.restockedQuantity} + ${line.quantity}`,
      })
      .where(
        and(
          eq(orderItems.id, line.orderItemId),
          // Scoping to the order stops a line from another order being
          // restocked through this one.
          eq(orderItems.orderId, orderId),
          sql`${orderItems.restockedQuantity} + ${line.quantity} <= ${orderItems.quantity}`,
        ),
      )
      .returning({ productId: orderItems.productId });

    if (claimed.length === 0) {
      throw new RestockNotAllowedError(
        "that is more than was ordered, or the line is not on this order",
      );
    }

    await tx
      .update(inventory)
      .set({
        onHand: sql`${inventory.onHand} + ${line.quantity}`,
        updatedAt: new Date(),
      })
      .where(eq(inventory.productId, claimed[0].productId));

    await tx.insert(inventoryAdjustments).values({
      productId: claimed[0].productId,
      delta: line.quantity,
      reason: "refund_restock",
      adminUserId,
    });
  }
}
