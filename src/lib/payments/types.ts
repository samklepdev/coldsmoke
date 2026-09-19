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
  }): Promise<{ refundId: string }>;

  verifyWebhook(rawBody: string, signature: string): WebhookEvent;
}
