import { describe, it, expect } from "vitest";
import { formatOrderNumber, parseOrderNumber } from "./format";

describe("order number formatting", () => {
  it("renders with the CS prefix", () => {
    expect(formatOrderNumber(1042)).toBe("CS-1042");
  });

  it("round-trips", () => {
    expect(parseOrderNumber(formatOrderNumber(1042))).toBe(1042);
  });

  it("parses a bare number", () => {
    expect(parseOrderNumber("1042")).toBe(1042);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(parseOrderNumber("  cs-1042 ")).toBe(1042);
  });

  it("rejects nonsense", () => {
    expect(parseOrderNumber("not-an-order")).toBeNull();
    expect(parseOrderNumber("")).toBeNull();
  });
});
