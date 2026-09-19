export const FLAT_SHIPPING_CENTS = 600;
export const FREE_SHIPPING_THRESHOLD_CENTS = 5000;

export type QuoteLine = {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
};

export type AppliedDiscount = {
  id: string;
  code: string;
  type: "percent" | "fixed";
  value: number;
};

export type Quote = {
  lines: QuoteLine[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
};

/**
 * The single place money is computed. The cart page, PaymentIntent creation,
 * and the Stripe webhook all call this, so they cannot disagree.
 *
 * Pure by design: tax is supplied by the caller (lib/payments fetches it from
 * Stripe Tax) rather than fetched here, so every branch is unit-testable.
 */
export function quote(
  lines: QuoteLine[],
  discount: AppliedDiscount | null = null,
  taxCents = 0,
): Quote {
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(
        `Line ${line.productId}: quantity must be a positive integer`,
      );
    }
    if (!Number.isInteger(line.unitPriceCents)) {
      throw new Error(
        `Line ${line.productId}: price must be an integer number of cents`,
      );
    }
  }
  if (!Number.isInteger(taxCents) || taxCents < 0) {
    throw new Error("Tax cannot be negative and must be integer cents");
  }

  const subtotalCents = lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0,
  );

  const discountCents = computeDiscount(subtotalCents, discount);
  const discountedSubtotal = subtotalCents - discountCents;

  // The free-shipping threshold is evaluated on the post-discount subtotal:
  // a discount should not be able to buy free shipping.
  const shippingCents =
    subtotalCents === 0 || discountedSubtotal >= FREE_SHIPPING_THRESHOLD_CENTS
      ? 0
      : FLAT_SHIPPING_CENTS;

  return {
    lines,
    subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    totalCents: discountedSubtotal + shippingCents + taxCents,
  };
}

function computeDiscount(
  subtotalCents: number,
  discount: AppliedDiscount | null,
): number {
  if (!discount || subtotalCents === 0) return 0;

  const raw =
    discount.type === "percent"
      ? Math.round((subtotalCents * discount.value) / 100)
      : discount.value;

  // Never discount below zero — a fixed code larger than the cart must not
  // produce a negative total.
  return Math.min(raw, subtotalCents);
}
