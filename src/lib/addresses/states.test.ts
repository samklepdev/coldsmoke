import { describe, it, expect } from "vitest";
import { US_STATES, US_STATE_CODES } from "./states";

const codes: readonly string[] = US_STATE_CODES;

describe("US_STATES", () => {
  it("lists the 50 states and DC", () => {
    expect(US_STATES).toHaveLength(51);
    expect(codes).toContain("DC");
  });

  it("omits territories and military codes", () => {
    // Deliberate: the store ships ground within the US only, and offering a
    // destination it cannot fulfil is worse than omitting it. If a shipping
    // decision ever adds these, this is where that choice gets noticed.
    for (const code of ["PR", "VI", "GU", "AS", "MP", "AA", "AE", "AP"]) {
      expect(codes).not.toContain(code);
    }
  });

  it("has no duplicate code and no duplicate name", () => {
    expect(new Set(US_STATES.map((s) => s.code)).size).toBe(US_STATES.length);
    expect(new Set(US_STATES.map((s) => s.name)).size).toBe(US_STATES.length);
  });

  it("is sorted by name, so the dropdown reads alphabetically", () => {
    const names = US_STATES.map((s) => s.name);
    expect(names).toEqual([...names].sort());
  });

  it("uses two uppercase letters for every code", () => {
    for (const { code } of US_STATES) expect(code).toMatch(/^[A-Z]{2}$/);
  });

  it("exposes one code per state, in the same order", () => {
    expect(US_STATE_CODES).toEqual(US_STATES.map((s) => s.code));
  });
});
