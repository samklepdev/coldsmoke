import type { Metadata } from "next";
import Link from "next/link";
import { requireSessionUser } from "@/lib/auth/session";
import { getOrdersForUser } from "@/lib/orders/history";
import { formatOrderNumber } from "@/lib/orders/format";
import { Price } from "@/components/ui/Price";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Your orders" };

export default async function AccountOrdersPage() {
  // The layout already enforces this; calling it again is how the page gets
  // the user, not a second gate.
  const user = await requireSessionUser("/account/orders");
  const orders = await getOrdersForUser(user.id);

  if (orders.length === 0) {
    return (
      <p>
        No orders yet. <Link href="/shop">Have a look</Link>.
      </p>
    );
  }

  return (
    <div>
      {orders.map((order) => (
        <article key={order.id} className={styles.order}>
          <div className={styles.meta}>
            <span>{formatOrderNumber(order.orderNumber)}</span>
            <span>{order.createdAt.toLocaleDateString("en-US")}</span>
            <span>{order.status}</span>
          </div>
          <p>
            {order.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")}
            {" — "}
            <Price cents={order.totalCents} />
          </p>
        </article>
      ))}
    </div>
  );
}
