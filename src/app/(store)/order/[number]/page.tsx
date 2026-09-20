import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  findOrderByNumber,
  parseOrderNumber,
  formatOrderNumber,
} from "@/lib/orders";
import { formatCents } from "@/lib/money";
import { PendingNotice } from "./PendingNotice";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Your order" };

const STATUS_COPY: Record<string, string> = {
  pending: "Awaiting payment",
  paid: "Confirmed",
  fulfilled: "Shipped",
  payment_failed: "Payment failed",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

export default async function OrderPage({
  params,
  searchParams,
}: PageProps<"/order/[number]">) {
  const { number } = await params;
  const { email } = await searchParams;

  const orderNumber = parseOrderNumber(number);
  const emailParam = typeof email === "string" ? email : null;

  // Guest orders are protected by requiring the email that placed them —
  // an order number alone must not expose an address.
  if (orderNumber === null || !emailParam) notFound();

  const order = await findOrderByNumber(orderNumber, emailParam);
  if (!order) notFound();

  const address = order.shippingAddress;

  return (
    <div className={styles.page}>
      <p className={styles.status}>
        {STATUS_COPY[order.status] ?? order.status}
      </p>
      <h1 className={styles.number}>{formatOrderNumber(order.orderNumber)}</h1>

      {order.status === "pending" && <PendingNotice />}

      {order.status === "paid" && (
        <p className={styles.thanks}>
          Thank you. We&apos;ll email you when it ships.
        </p>
      )}

      <div className={styles.section}>
        <p className={styles.label}>Items</p>
        {order.items.map((item) => (
          <div key={item.id} className={styles.line}>
            <span>
              {item.name} × {item.quantity}
            </span>
            <span>{formatCents(item.totalCents)}</span>
          </div>
        ))}

        <div className={styles.row}>
          <span>Subtotal</span>
          <span>{formatCents(order.subtotalCents)}</span>
        </div>
        {order.discountCents > 0 && (
          <div className={styles.row}>
            <span>Discount</span>
            <span>-{formatCents(order.discountCents)}</span>
          </div>
        )}
        <div className={styles.row}>
          <span>Shipping</span>
          <span>
            {order.shippingCents === 0
              ? "Free"
              : formatCents(order.shippingCents)}
          </span>
        </div>
        <div className={styles.row}>
          <span>Tax</span>
          <span>{formatCents(order.taxCents)}</span>
        </div>
        <div className={`${styles.row} ${styles.total}`}>
          <span>Total</span>
          <span>{formatCents(order.totalCents)}</span>
        </div>
      </div>

      <div className={styles.section}>
        <p className={styles.label}>Shipping to</p>
        <p>
          {address.name}
          <br />
          {address.line1}
          {address.line2 && (
            <>
              <br />
              {address.line2}
            </>
          )}
          <br />
          {address.city}, {address.state} {address.postalCode}
        </p>
      </div>

      {order.trackingNumber && (
        <div className={styles.section}>
          <p className={styles.label}>Tracking</p>
          <p>
            {order.carrier} {order.trackingNumber}
          </p>
        </div>
      )}
    </div>
  );
}
