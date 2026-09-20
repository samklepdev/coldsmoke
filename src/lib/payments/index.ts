import type { PaymentsAdapter } from "./types";
import { StripePayments } from "./stripe";

export * from "./types";

let instance: PaymentsAdapter | null = null;

export function getPayments(): PaymentsAdapter {
  if (!instance) instance = new StripePayments();
  return instance;
}

/** Test seam — lets integration tests install FakePayments. */
export function setPayments(adapter: PaymentsAdapter): void {
  instance = adapter;
}
