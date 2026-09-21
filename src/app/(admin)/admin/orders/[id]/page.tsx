import { notFound } from "next/navigation";
import { findOrderById } from "@/lib/orders";
import { formatOrderNumber } from "@/lib/orders/format";
import { formatCents } from "@/lib/money";
import { FulfillForm } from "./FulfillForm";
import { RefundButton } from "./RefundButton";
import styles from "./detail.module.css";

// Matches the list page's `.toISOString().slice(0, 10)` date — a plain date
// is what an admin scanning order history needs; millisecond precision is noise.
function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

// Shipped is the one timestamp where the time-of-day is genuinely useful
// (e.g. confirming same-day dispatch), so keep it to the minute.
function formatDateTime(date: Date) {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

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
        <dd>{formatDate(order.createdAt)}</dd>
        {order.paidAt ? (
          <>
            <dt>Paid</dt>
            <dd>{formatDate(order.paidAt)}</dd>
          </>
        ) : null}
        {order.fulfilledAt ? (
          <>
            <dt>Shipped</dt>
            <dd>
              {formatDateTime(order.fulfilledAt)} · {order.carrier} ·{" "}
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
        <thead>
          <tr>
            <th>Item</th>
            <th className={styles.right}>Amount</th>
          </tr>
        </thead>
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

      {/* Only a paid order can ship. fulfillOrder enforces this too; the
          condition here just avoids offering an action that would be refused. */}
      {order.status === "paid" ? (
        <>
          <h2 className={styles.subheading}>Fulfil</h2>
          <FulfillForm orderId={order.id} />
        </>
      ) : null}

      {/* A refunded or unpaid order has nothing left to give back. refundOrder
          enforces this too; the condition just avoids offering a refused action. */}
      {(order.status === "paid" || order.status === "fulfilled") &&
      order.totalCents > order.refundedCents ? (
        <>
          <h2 className={styles.subheading}>Refund</h2>
          <RefundButton
            orderId={order.id}
            amountCents={order.totalCents - order.refundedCents}
          />
        </>
      ) : null}
    </section>
  );
}
