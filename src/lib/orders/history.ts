import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { orders, orderItems } from "@/lib/db/schema";
import type { OrderWithItems } from "./index";

/**
 * A customer's own orders, newest first.
 *
 * Filtered on userId and nothing else. An order with a null userId is a guest
 * order nobody has proven they own, and it stays invisible here until
 * claimGuestOrders attaches it on verification.
 */
export async function getOrdersForUser(userId: string): Promise<OrderWithItems[]> {
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt));

  if (rows.length === 0) return [];

  // One query for every line rather than one per order.
  const items = await db
    .select()
    .from(orderItems)
    .where(
      inArray(
        orderItems.orderId,
        rows.map((o) => o.id),
      ),
    );

  const byOrder = new Map<string, typeof items>();
  for (const item of items) {
    const list = byOrder.get(item.orderId) ?? [];
    list.push(item);
    byOrder.set(item.orderId, list);
  }

  return rows.map((order) => ({ ...order, items: byOrder.get(order.id) ?? [] }));
}
