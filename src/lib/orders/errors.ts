/**
 * Errors for the admin-driven order transitions.
 *
 * Separate from the errors in index.ts so fulfill.ts and refund.ts can import
 * them without pulling in index.ts, which keeps the dependency one-way: the
 * new transition files may read from index.ts, and index.ts never reads back.
 */

export class OrderNotFoundError extends Error {
  constructor(public readonly orderId: string) {
    super(`No order ${orderId}`);
    this.name = "OrderNotFoundError";
  }
}

/** Only a paid order can ship. */
export class OrderNotFulfillableError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly status: string,
  ) {
    super(`Order ${orderId} is "${status}", not "paid", so it cannot be fulfilled`);
    this.name = "OrderNotFulfillableError";
  }
}

/**
 * Covers three refusals that are one thing to the admin: there is no money to
 * give back. Either the order was never paid, or it has no payment intent, or
 * it is already fully refunded.
 */
export class OrderNotRefundableError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly reason: string,
  ) {
    super(`Order ${orderId} cannot be refunded: ${reason}`);
    this.name = "OrderNotRefundableError";
  }
}
