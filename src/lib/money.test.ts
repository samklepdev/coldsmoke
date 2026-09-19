import { describe, it, expect } from "vitest";
import { formatCents } from "./money";

describe("formatCents", () => {
  it("formats whole dollars", () => {
    expect(formatCents(4500)).toBe("$45.00");
  });

  it("formats cents", () => {
    expect(formatCents(605)).toBe("$6.05");
  });

  it("formats zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });

  it("formats large amounts with a thousands separator", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
  });

  it("formats negative amounts, used for discount lines", () => {
    expect(formatCents(-500)).toBe("-$5.00");
  });
});
