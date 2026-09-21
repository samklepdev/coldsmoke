import type { Address } from "@/lib/db/schema";
import type { QuoteLine } from "@/lib/pricing/quote";

export type TaxCalculation = {
  taxCents: number;
  calculationId: string | null;
};

export type IntentResult = {
  paymentIntentId: string;
  clientSecret: string;
};

export type WebhookEvent = {
  id: string;
  type: string;
  paymentIntentId: string | null;
  amountCents: number | null;
  metadata: Record<string, string>;
};

/**
 * The boundary around Stripe. Every other module depends on this interface, so
 * tests substitute FakePayments and run with no network access.
 */
/**
 * Thrown when a PaymentIntent can no longer be modified because it reached a
 * terminal state — typically the order was already paid. Callers should treat
 * this as "this order is finished", not as a retryable failure.
 */
export class PaymentIntentNotUpdatableError extends Error {
  constructor(
    public readonly paymentIntentId: string,
    public readonly status: string,
  ) {
    super(`PaymentIntent ${paymentIntentId} is ${status} and cannot be updated`);
    this.name = "PaymentIntentNotUpdatableError";
  }
}

export interface PaymentsAdapter {
  calculateTax(args: {
    lines: QuoteLine[];
    shippingCents: number;
    discountCents: number;
    address: Address;
  }): Promise<TaxCalculation>;

  createOrUpdateIntent(args: {
    paymentIntentId: string | null;
    amountCents: number;
    email: string;
    orderId: string;
    orderNumber: number;
  }): Promise<IntentResult>;

  refund(args: {
    paymentIntentId: string;
    amountCents: number;
    /**
     * Stable per logical refund. Two submits of the same refund send the same
     * key, so Stripe returns the original refund instead of issuing a second
     * one or rejecting the amount as exceeding what is left.
     */
    idempotencyKey: string;
  }): Promise<{ refundId: string }>;

  verifyWebhook(rawBody: string, signature: string): WebhookEvent;
}
