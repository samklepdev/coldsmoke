import Link from "next/link";
import { listOrdersForAdmin, ADMIN_PAGE_SIZE } from "@/lib/orders/adminList";
import { formatOrderNumber } from "@/lib/orders/format";
import { formatCents } from "@/lib/money";
import { orderStatus } from "@/lib/db/schema";
import styles from "./orders.module.css";

/**
 * Search and filter live in the URL rather than in client state, so a
 * filtered list survives a reload and can be sent to someone.
 */
export default async function AdminOrdersPage({
  searchParams,
}: PageProps<"/admin/orders">) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : undefined;
  const status = typeof params.status === "string" ? params.status : undefined;
  const page = typeof params.page === "string" ? Number(params.page) : 1;

  const { rows, total } = await listOrdersForAdmin({
    query,
    status,
    page: Number.isFinite(page) ? page : 1,
  });

  const pages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);

  return (
    <section>
      <h1 className={styles.heading}>Orders</h1>

      <form className={styles.filters} method="get">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Order number or email"
          aria-label="Search orders"
        />
        <select name="status" defaultValue={status ?? ""} aria-label="Status">
          <option value="">All statuses</option>
          {orderStatus.enumValues.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button type="submit">Filter</button>
      </form>

      {rows.length === 0 ? (
        <p>No orders match.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Order</th>
              <th>Placed</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((order) => (
              <tr key={order.id}>
                <td>
                  <Link href={`/admin/orders/${order.id}`}>
                    {formatOrderNumber(order.orderNumber)}
                  </Link>
                </td>
                <td>{order.createdAt.toISOString().slice(0, 10)}</td>
                <td>{order.email}</td>
                <td>{order.status}</td>
                <td>{formatCents(order.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className={styles.count}>
        {total} order{total === 1 ? "" : "s"} · page {current} of {pages}
      </p>
    </section>
  );
}
