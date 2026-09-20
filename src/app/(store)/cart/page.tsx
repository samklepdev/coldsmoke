import type { Metadata } from "next";
import { getCartId, getCartLines } from "@/lib/cart";
import { quote, FREE_SHIPPING_THRESHOLD_CENTS } from "@/lib/pricing/quote";
import { formatCents } from "@/lib/money";
import { ButtonLink } from "@/components/ui/Button";
import { getActiveDiscount } from "../actions";
import { DiscountForm } from "./DiscountForm";
import { QuantityStepper } from "./QuantityStepper";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Cart" };

export default async function CartPage() {
  const cartId = await getCartId();
  const lines = cartId ? await getCartLines(cartId) : [];
  const discount = await getActiveDiscount();
  const summary = quote(lines, discount);

  if (lines.length === 0) {
    return (
      <div className={styles.page}>
        <h1 className={styles.heading}>Cart</h1>
        <p className={styles.empty}>Your cart is empty.</p>
        <p className={styles.emptyCta}>
          <ButtonLink href="/shop">Shop</ButtonLink>
        </p>
      </div>
    );
  }

  // quote() evaluates free shipping on the post-discount subtotal, so this
  // countdown has to use the same basis or it would promise a threshold the
  // pricing module does not honour.
  const remaining =
    FREE_SHIPPING_THRESHOLD_CENTS -
    (summary.subtotalCents - summary.discountCents);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Cart</h1>

      {lines.map((line) => (
        <div key={line.productId} className={styles.line}>
          <div>
            <div className={styles.lineName}>{line.name}</div>
            <div className={styles.lineUnit}>
              {formatCents(line.unitPriceCents)} each
            </div>
          </div>

          <QuantityStepper
            productId={line.productId}
            name={line.name}
            quantity={line.quantity}
          />

          <div>{formatCents(line.unitPriceCents * line.quantity)}</div>
        </div>
      ))}

      <div className={styles.summary}>
        <DiscountForm applied={discount?.code ?? null} />

        <div className={styles.totals}>
          <div className={styles.row}>
            <span>Subtotal</span>
            <span>{formatCents(summary.subtotalCents)}</span>
          </div>

          {summary.discountCents > 0 && (
            <div className={styles.row}>
              <span>Discount</span>
              <span>-{formatCents(summary.discountCents)}</span>
            </div>
          )}

          <div className={styles.row}>
            <span>Shipping</span>
            <span>
              {summary.shippingCents === 0
                ? "Free"
                : formatCents(summary.shippingCents)}
            </span>
          </div>

          <div className={`${styles.row} ${styles.total}`}>
            <span>Total before tax</span>
            <span>{formatCents(summary.totalCents)}</span>
          </div>

          {remaining > 0 && (
            <p className={styles.note}>
              {formatCents(remaining)} more for free shipping.
            </p>
          )}
          <p className={styles.note}>Tax is calculated at checkout.</p>

          <ButtonLink
            href="/checkout"
            variant="primary"
            block
            className={styles.checkoutCta}
          >
            Checkout
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
