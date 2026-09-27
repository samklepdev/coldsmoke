import Stripe from "stripe";
import type {
  PaymentsAdapter,
  TaxCalculation,
  IntentResult,
  WebhookEvent,
} from "./types";
import { PaymentIntentNotUpdatableError } from "./types";

const TERMINAL_INTENT_STATUSES = new Set(["succeeded", "canceled", "processing"]);

// This is the ONLY file permitted to import the stripe package.
let stripeClient: Stripe | null = null;

/**
 * Built on first use, not on import. The Stripe constructor throws on a falsy
 * key, and `next build` imports this module's graph to collect route config —
 * so constructing at module scope would make STRIPE_SECRET_KEY a build-time
 * requirement. See the note on `db` in lib/db/client.ts.
 */
/**
 * Cap for Stripe calls made while rendering a page, rather than from a Server
 * Action where a spinner is expected. 3s is comfortably above Stripe's p99 for
 * a single retrieve and well under anyone's patience for a page that is
 * supposed to answer "did my payment go through".
 */
const RENDER_PATH_TIMEOUT_MS = 3_000;

function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    stripeClient = new Stripe(key, { apiVersion: "2026-08-26.dahlia" });
  }
  return stripeClient;
}

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

    const calculation = await getStripe().tax.calculations.create({
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

    let intent: Stripe.PaymentIntent;
    if (paymentIntentId) {
      const existing = await getStripe().paymentIntents.retrieve(paymentIntentId);
      if (TERMINAL_INTENT_STATUSES.has(existing.status)) {
        // Do NOT fall back to creating a replacement intent here. If the
        // original already succeeded, the customer has paid; quietly minting
        // a second intent invites a double charge. Callers must treat this
        // as terminal, not retryable.
        throw new PaymentIntentNotUpdatableError(paymentIntentId, existing.status);
      }
      intent = await getStripe().paymentIntents.update(paymentIntentId, {
        amount: amountCents,
        receipt_email: email,
        metadata,
      });
    } else {
      intent = await getStripe().paymentIntents.create({
        amount: amountCents,
        currency: "usd",
        receipt_email: email,
        metadata,
        automatic_payment_methods: { enabled: true },
      });
    }

    return {
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret!,
    };
  }

  async refund({
    paymentIntentId,
    amountCents,
    idempotencyKey,
  }: Parameters<PaymentsAdapter["refund"]>[0]) {
    const refund = await getStripe().refunds.create(
      { payment_intent: paymentIntentId, amount: amountCents },
      { idempotencyKey },
    );
    return { refundId: refund.id };
  }

  async getIntentStatus(paymentIntentId: string): Promise<string | null> {
    try {
      // Short timeout because the only caller runs this during a page render.
      // stripe-node's default is 80s, which turns a hung connection into a hung
      // confirmation page — on the page a customer loads specifically to find
      // out whether they were charged. "Degrade to Awaiting payment" has to mean
      // degrade quickly; a thrown timeout is what the caller's catch expects.
      //
      // Empty params, then request options — `timeout` is a per-request option,
      // and with one argument TS resolves it against PaymentIntentRetrieveParams.
      const intent = await getStripe().paymentIntents.retrieve(
        paymentIntentId,
        {},
        { timeout: RENDER_PATH_TIMEOUT_MS },
      );
      return intent.status;
    } catch (error) {
      // An id Stripe does not know is an answer, not a failure: it means this
      // order never had a real intent. Anything else -- network, auth, rate
      // limit -- is a genuine failure and must propagate, so the caller can
      // tell "definitely not paid" from "could not find out".
      if (error instanceof Stripe.errors.StripeInvalidRequestError) return null;
      throw error;
    }
  }

  verifyWebhook(rawBody: string, signature: string): WebhookEvent {
    const event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );

    const object = event.data.object as unknown as Record<string, unknown>;
    const paymentIntentId =
      event.type.startsWith("payment_intent.")
        ? (object.id as string)
        : ((object.payment_intent as string) ?? null);

    // For a refund event, the charge's `amount` is its original total, not
    // what was refunded. `amount_refunded` is the actual refunded amount.
    const amountField =
      event.type === "charge.refunded" ? object.amount_refunded : object.amount;

    return {
      id: event.id,
      type: event.type,
      paymentIntentId,
      amountCents: typeof amountField === "number" ? amountField : null,
      metadata: (object.metadata as Record<string, string>) ?? {},
    };
  }
}
