import Stripe from "stripe";
import type {
  PaymentsAdapter,
  TaxCalculation,
  IntentResult,
  WebhookEvent,
} from "./types";

// This is the ONLY file permitted to import the stripe package.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-08-26.dahlia",
});

export class StripePayments implements PaymentsAdapter {
  async calculateTax({
    lines,
    shippingCents,
    discountCents,
    address,
  }: Parameters<PaymentsAdapter["calculateTax"]>[0]): Promise<TaxCalculation> {
    const subtotal = lines.reduce(
      (sum, l) => sum + l.unitPriceCents * l.quantity,
      0,
    );

    const calculation = await stripe.tax.calculations.create({
      currency: "usd",
      customer_details: {
        address: {
          line1: address.line1,
          line2: address.line2,
          city: address.city,
          state: address.state,
          postal_code: address.postalCode,
          country: "US",
        },
        address_source: "shipping",
      },
      line_items: [
        {
          amount: subtotal - discountCents,
          reference: "cart",
          tax_behavior: "exclusive",
          tax_code: "txcd_30060006", // Cosmetics and personal care
        },
      ],
      shipping_cost: { amount: shippingCents, tax_behavior: "exclusive" },
    });

    return {
      taxCents: calculation.tax_amount_exclusive,
      calculationId: calculation.id ?? null,
    };
  }

  async createOrUpdateIntent({
    paymentIntentId,
    amountCents,
    email,
    orderId,
    orderNumber,
  }: Parameters<
    PaymentsAdapter["createOrUpdateIntent"]
  >[0]): Promise<IntentResult> {
    const metadata = { orderId, orderNumber: String(orderNumber) };

    const intent = paymentIntentId
      ? await stripe.paymentIntents.update(paymentIntentId, {
          amount: amountCents,
          receipt_email: email,
          metadata,
        })
      : await stripe.paymentIntents.create({
          amount: amountCents,
          currency: "usd",
          receipt_email: email,
          metadata,
          automatic_payment_methods: { enabled: true },
        });

    return {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret!,
    };
  }

  async refund({
    paymentIntentId,
    amountCents,
  }: Parameters<PaymentsAdapter["refund"]>[0]) {
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: amountCents,
    });
    return { refundId: refund.id };
  }

  verifyWebhook(rawBody: string, signature: string): WebhookEvent {
    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );

    const object = event.data.object as unknown as Record<string, unknown>;
    const paymentIntentId =
      event.type.startsWith("payment_intent.")
        ? (object.id as string)
        : ((object.payment_intent as string) ?? null);

    return {
      id: event.id,
      type: event.type,
      paymentIntentId,
      amountCents: typeof object.amount === "number" ? object.amount : null,
      metadata: (object.metadata as Record<string, string>) ?? {},
    };
  }
}
