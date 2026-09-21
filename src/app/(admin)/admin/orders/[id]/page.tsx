import { notFound } from "next/navigation";
import { findOrderById } from "@/lib/orders";
import { formatOrderNumber } from "@/lib/orders/format";
import { formatCents } from "@/lib/money";
import styles from "./detail.module.css";

export default async function AdminOrderDetailPage({
  params,
}: PageProps<"/admin/orders/[id]">) {
  const { id } = await params;
  const order = await findOrderById(id);

  if (!order) notFound();

  const address = order.shippingAddress;
  const refunded = order.refundedCents > 0;

  return (
    <section>
      <h1 className={styles.heading}>
        {formatOrderNumber(order.orderNumber)}
        <span className={styles.status}>{order.status}</span>
      </h1>

      <dl className={styles.facts}>
        <dt>Customer</dt>
        <dd>{order.email}</dd>
        <dt>Placed</dt>
        <dd>{order.createdAt.toISOString()}</dd>
        {order.paidAt ? (
          <>
            <dt>Paid</dt>
            <dd>{order.paidAt.toISOString()}</dd>
          </>
        ) : null}
        {order.fulfilledAt ? (
          <>
            <dt>Shipped</dt>
            <dd>
              {order.fulfilledAt.toISOString()} · {order.carrier} ·{" "}
              {order.trackingNumber}
            </dd>
          </>
        ) : null}
        {refunded ? (
          <>
            <dt>Refunded</dt>
            <dd>{formatCents(order.refundedCents)}</dd>
          </>
        ) : null}
      </dl>

      <h2 className={styles.subheading}>Items</h2>
      <table className={styles.table}>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.id}>
              <td>
                {item.name} × {item.quantity}
              </td>
              <td className={styles.right}>{formatCents(item.totalCents)}</td>
            </tr>
          ))}
          <tr>
            <td>Subtotal</td>
            <td className={styles.right}>{formatCents(order.subtotalCents)}</td>
          </tr>
          {order.discountCents > 0 ? (
            <tr>
              <td>Discount</td>
              <td className={styles.right}>
                -{formatCents(order.discountCents)}
              </td>
            </tr>
          ) : null}
          <tr>
            <td>Shipping</td>
            <td className={styles.right}>{formatCents(order.shippingCents)}</td>
          </tr>
          <tr>
            <td>Tax</td>
            <td className={styles.right}>{formatCents(order.taxCents)}</td>
          </tr>
          <tr>
            <td>Total</td>
            <td className={styles.right}>{formatCents(order.totalCents)}</td>
          </tr>
        </tbody>
      </table>

      <h2 className={styles.subheading}>Shipping to</h2>
      <address className={styles.address}>
        {address.name}
        <br />
        {address.line1}
        {address.line2 ? (
          <>
            <br />
            {address.line2}
          </>
        ) : null}
        <br />
        {address.city}, {address.state} {address.postalCode}
      </address>
    </section>
  );
}
