import type {
  PaymentsAdapter,
  TaxCalculation,
  IntentResult,
  WebhookEvent,
} from "./types";
import { PaymentIntentNotUpdatableError } from "./types";

const TERMINAL_INTENT_STATUSES = new Set(["succeeded", "canceled", "processing"]);

type FakeIntent = { amountCents: number; orderId: string; status: string };

/**
 * In-memory adapter for tests. Tax is a flat 8% of the taxable base so
 * assertions stay predictable.
 */
export class FakePayments implements PaymentsAdapter {
  public intents = new Map<string, FakeIntent>();
  public refunds: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
  }[] = [];
  private counter = 0;

  async calculateTax({
    lines,
    shippingCents,
    discountCents,
  }: Parameters<PaymentsAdapter["calculateTax"]>[0]): Promise<TaxCalculation> {
    const subtotal = lines.reduce(
      (sum, l) => sum + l.unitPriceCents * l.quantity,
      0,
    );
    const base = subtotal - discountCents + shippingCents;
    return { taxCents: Math.round(base * 0.08), calculationId: "taxcalc_fake" };
  }

  async createOrUpdateIntent({
    paymentIntentId,
    amountCents,
    orderId,
  }: Parameters<
    PaymentsAdapter["createOrUpdateIntent"]
  >[0]): Promise<IntentResult> {
    if (paymentIntentId) {
      const existing = this.intents.get(paymentIntentId);
      if (existing && TERMINAL_INTENT_STATUSES.has(existing.status)) {
        // Mirrors StripePayments: do NOT fall back to creating a replacement
        // intent here. If the original already succeeded, the customer has
        // paid; quietly minting a second intent invites a double charge.
        throw new PaymentIntentNotUpdatableError(paymentIntentId, existing.status);
      }
    }

    const id = paymentIntentId ?? `pi_fake_${++this.counter}`;
    const status = this.intents.get(id)?.status ?? "requires_payment_method";
    this.intents.set(id, { amountCents, orderId, status });
    return { paymentIntentId: id, clientSecret: `${id}_secret` };
  }

  /** Test helper: flips an intent's status to "succeeded" so tests can set
   * up the terminal-state scenario. */
  markSucceeded(paymentIntentId: string): void {
    const existing = this.intents.get(paymentIntentId);
    if (!existing) {
      throw new Error(`No fake intent ${paymentIntentId} to mark succeeded`);
    }
    existing.status = "succeeded";
  }

  async refund({
    paymentIntentId,
    amountCents,
    idempotencyKey,
  }: Parameters<PaymentsAdapter["refund"]>[0]) {
    // Mirrors Stripe: a repeated key returns the original refund rather than
    // creating a second one. Without this the fake would happily record two
    // refunds for a double submit and the tests would not catch a real one.
    const seen = this.refunds.findIndex(
      (r) => r.idempotencyKey === idempotencyKey,
    );
    if (seen !== -1) return { refundId: `re_fake_${seen + 1}` };

    this.refunds.push({ paymentIntentId, amountCents, idempotencyKey });
    return { refundId: `re_fake_${this.refunds.length}` };
  }

  verifyWebhook(rawBody: string): WebhookEvent {
    return JSON.parse(rawBody) as WebhookEvent;
  }

  /** Test helper: builds a webhook payload this adapter will accept. */
  succeededEvent(paymentIntentId: string, eventId = "evt_fake_1"): string {
    const intent = this.intents.get(paymentIntentId);
    return JSON.stringify({
      id: eventId,
      type: "payment_intent.succeeded",
      paymentIntentId,
      amountCents: intent?.amountCents ?? 0,
      metadata: { orderId: intent?.orderId ?? "" },
    } satisfies WebhookEvent);
  }
}
