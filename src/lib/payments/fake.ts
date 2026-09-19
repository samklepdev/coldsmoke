import type {
  PaymentsAdapter,
  TaxCalculation,
  IntentResult,
  WebhookEvent,
} from "./types";

/**
 * In-memory adapter for tests. Tax is a flat 8% of the taxable base so
 * assertions stay predictable.
 */
export class FakePayments implements PaymentsAdapter {
  public intents = new Map<string, { amountCents: number; orderId: string }>();
  public refunds: { paymentIntentId: string; amountCents: number }[] = [];
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
    const id = paymentIntentId ?? `pi_fake_${++this.counter}`;
    this.intents.set(id, { amountCents, orderId });
    return { paymentIntentId: id, clientSecret: `${id}_secret` };
  }

  async refund({
    paymentIntentId,
    amountCents,
  }: Parameters<PaymentsAdapter["refund"]>[0]) {
    this.refunds.push({ paymentIntentId, amountCents });
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
