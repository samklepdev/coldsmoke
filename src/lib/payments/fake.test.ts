import { describe, it, expect, beforeEach } from "vitest";
import { FakePayments } from "./fake";
import { PaymentIntentNotUpdatableError } from "./types";

describe("FakePayments", () => {
  let fake: FakePayments;

  beforeEach(() => {
    fake = new FakePayments();
  });

  it("creating an intent returns an id and a client secret derived from it", async () => {
    const result = await fake.createOrUpdateIntent({
      paymentIntentId: null,
      amountCents: 4500,
      email: "buyer@example.com",
      orderId: "order_1",
      orderNumber: 1,
    });

    expect(result.paymentIntentId).toBeTruthy();
    expect(result.clientSecret).toBe(`${result.paymentIntentId}_secret`);
  });

  it("calling again with that id updates in place", async () => {
    const first = await fake.createOrUpdateIntent({
      paymentIntentId: null,
      amountCents: 4500,
      email: "buyer@example.com",
      orderId: "order_1",
      orderNumber: 1,
    });

    await fake.createOrUpdateIntent({
      paymentIntentId: first.paymentIntentId,
      amountCents: 9000,
      email: "buyer@example.com",
      orderId: "order_1",
      orderNumber: 1,
    });

    expect(fake.intents.size).toBe(1);
  });

  it("throws PaymentIntentNotUpdatableError with id and status after markSucceeded", async () => {
    const first = await fake.createOrUpdateIntent({
      paymentIntentId: null,
      amountCents: 4500,
      email: "buyer@example.com",
      orderId: "order_1",
      orderNumber: 1,
    });

    fake.markSucceeded(first.paymentIntentId);

    await expect(
      fake.createOrUpdateIntent({
        paymentIntentId: first.paymentIntentId,
        amountCents: 9000,
        email: "buyer@example.com",
        orderId: "order_1",
        orderNumber: 1,
      }),
    ).rejects.toThrow(PaymentIntentNotUpdatableError);

    try {
      await fake.createOrUpdateIntent({
        paymentIntentId: first.paymentIntentId,
        amountCents: 9000,
        email: "buyer@example.com",
        orderId: "order_1",
        orderNumber: 1,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentIntentNotUpdatableError);
      const typed = err as PaymentIntentNotUpdatableError;
      expect(typed.paymentIntentId).toBe(first.paymentIntentId);
      expect(typed.status).toBe("succeeded");
    }
  });

  it("succeededEvent() round-trips through verifyWebhook", async () => {
    const first = await fake.createOrUpdateIntent({
      paymentIntentId: null,
      amountCents: 4500,
      email: "buyer@example.com",
      orderId: "order_1",
      orderNumber: 1,
    });

    const raw = fake.succeededEvent(first.paymentIntentId);
    const event = fake.verifyWebhook(raw);

    expect(event.type).toBe("payment_intent.succeeded");
    expect(event.paymentIntentId).toBe(first.paymentIntentId);
  });

  it("refund records the refund and returns an id", async () => {
    const first = await fake.createOrUpdateIntent({
      paymentIntentId: null,
      amountCents: 4500,
      email: "buyer@example.com",
      orderId: "order_1",
      orderNumber: 1,
    });

    const result = await fake.refund({
      paymentIntentId: first.paymentIntentId,
      amountCents: 4500,
    });

    expect(result.refundId).toBeTruthy();
    expect(fake.refunds).toContainEqual({
      paymentIntentId: first.paymentIntentId,
      amountCents: 4500,
    });
  });
});
