import { describe, it, expect } from "vitest";
import {
  quote,
  FLAT_SHIPPING_CENTS,
  FREE_SHIPPING_THRESHOLD_CENTS,
  type QuoteLine,
  type AppliedDiscount,
} from "./quote";

const bottle: QuoteLine = {
  productId: "p1",
  name: "Coldsmoke Eau de Toilette",
  unitPriceCents: 4500,
  quantity: 1,
};

const sample: QuoteLine = {
  productId: "p2",
  name: "Coldsmoke Sample",
  unitPriceCents: 600,
  quantity: 1,
};

const percent10: AppliedDiscount = {
  id: "d1",
  code: "welcome10",
  type: "percent",
  value: 10,
};

const fixed500: AppliedDiscount = {
  id: "d2",
  code: "five",
  type: "fixed",
  value: 500,
};

describe("quote — subtotal", () => {
  it("sums a single line", () => {
    expect(quote([bottle]).subtotalCents).toBe(4500);
  });

  it("multiplies by quantity", () => {
    expect(quote([{ ...bottle, quantity: 3 }]).subtotalCents).toBe(13500);
  });

  it("sums multiple lines", () => {
    expect(quote([bottle, sample]).subtotalCents).toBe(5100);
  });

  it("returns an all-zero quote for an empty cart", () => {
    const q = quote([]);
    expect(q).toMatchObject({
      subtotalCents: 0,
      discountCents: 0,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
  });
});

describe("quote — shipping threshold", () => {
  it("charges flat shipping below the threshold", () => {
    expect(quote([bottle]).shippingCents).toBe(FLAT_SHIPPING_CENTS);
  });

  it("charges flat shipping one cent below the threshold", () => {
    const line = { ...bottle, unitPriceCents: FREE_SHIPPING_THRESHOLD_CENTS - 1 };
    expect(quote([line]).shippingCents).toBe(FLAT_SHIPPING_CENTS);
  });

  it("gives free shipping exactly at the threshold", () => {
    const line = { ...bottle, unitPriceCents: FREE_SHIPPING_THRESHOLD_CENTS };
    expect(quote([line]).shippingCents).toBe(0);
  });

  it("gives free shipping above the threshold", () => {
    expect(quote([bottle, sample]).shippingCents).toBe(0);
  });

  it("charges no shipping on an empty cart", () => {
    expect(quote([]).shippingCents).toBe(0);
  });
});

describe("quote — discounts", () => {
  it("applies a percentage discount", () => {
    expect(quote([bottle], percent10).discountCents).toBe(450);
  });

  it("applies a fixed discount", () => {
    expect(quote([bottle], fixed500).discountCents).toBe(500);
  });

  it("never discounts more than the subtotal", () => {
    const q = quote([sample], { ...fixed500, value: 10000 });
    expect(q.discountCents).toBe(600);
    // subtotal 600, discount capped at 600 -> discountedSubtotal 0, which is
    // below the free-shipping threshold, so flat shipping applies, tax is 0:
    // total = 0 + 600 + 0 = 600.
    expect(q.totalCents).toBe(600);
  });

  it("rounds a percentage discount to the nearest cent", () => {
    // 5% of 605 = 30.25 -> 30
    const q = quote([{ ...sample, unitPriceCents: 605 }], {
      ...percent10,
      value: 5,
    });
    expect(q.discountCents).toBe(30);
  });

  it("evaluates the free-shipping threshold AFTER the discount", () => {
    // 5100 subtotal - 10% = 4590, which is below 5000, so shipping applies.
    const q = quote([bottle, sample], percent10);
    expect(q.subtotalCents).toBe(5100);
    expect(q.discountCents).toBe(510);
    expect(q.shippingCents).toBe(FLAT_SHIPPING_CENTS);
  });

  it("treats a null discount as no discount", () => {
    expect(quote([bottle], null).discountCents).toBe(0);
  });
});

describe("quote — tax and total", () => {
  it("includes supplied tax in the total", () => {
    const q = quote([bottle], null, 371);
    expect(q.taxCents).toBe(371);
    expect(q.totalCents).toBe(4500 + 600 + 371);
  });

  it("defaults tax to zero", () => {
    expect(quote([bottle]).taxCents).toBe(0);
  });

  it("computes total as subtotal - discount + shipping + tax", () => {
    const q = quote([bottle, sample], percent10, 400);
    expect(q.totalCents).toBe(5100 - 510 + FLAT_SHIPPING_CENTS + 400);
  });
});

describe("quote — invariants", () => {
  it("rejects a negative quantity", () => {
    expect(() => quote([{ ...bottle, quantity: -1 }])).toThrow(
      /quantity must be a positive integer/i,
    );
  });

  it("rejects a fractional quantity", () => {
    expect(() => quote([{ ...bottle, quantity: 1.5 }])).toThrow(
      /quantity must be a positive integer/i,
    );
  });

  it("rejects a non-integer price, guarding against float money", () => {
    expect(() => quote([{ ...bottle, unitPriceCents: 45.5 }])).toThrow(
      /must be an integer number of cents/i,
    );
  });

  it("rejects negative tax", () => {
    expect(() => quote([bottle], null, -1)).toThrow(/tax cannot be negative/i);
  });

  it("returns only integer cents in every field", () => {
    const q = quote([bottle, sample], { ...percent10, value: 7 }, 333);
    for (const value of [
      q.subtotalCents,
      q.discountCents,
      q.shippingCents,
      q.taxCents,
      q.totalCents,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("rejects a negative price", () => {
    expect(() => quote([{ ...bottle, unitPriceCents: -700 }])).toThrow(
      /price must not be negative/i,
    );
  });

  it("accepts a zero price for a free item", () => {
    const q = quote([{ ...bottle, unitPriceCents: 0 }]);
    expect(q.subtotalCents).toBe(0);
  });

  it("does not let the caller's array mutate the returned quote's lines", () => {
    const lines = [{ ...bottle }];
    const q = quote(lines);
    lines.push({ ...sample });
    lines[0].quantity = 99;
    expect(q.lines).toEqual([bottle]);
  });
});
