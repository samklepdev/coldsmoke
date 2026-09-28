import { describe, it, expect } from "vitest";
import { zonedDayBoundary, zonedDateString } from "./time";

/**
 * These assert exact instants on purpose.
 *
 * The bug these exist to prevent was invisible in a relative assertion: an
 * end date anchored at 23:59:59.999 UTC really is "later than the start of
 * the day" and really is "in the future" for most of the day, so every loose
 * check passed while every promotion still died five hours early in Houston.
 * Only the exact instant shows it.
 */
describe("zonedDayBoundary", () => {
  it("ends a summer day at midnight Houston, not midnight UTC", () => {
    // CDT, UTC-5. 23:59:59.999 local is 04:59:59.999Z the NEXT day.
    expect(
      zonedDayBoundary("2026-09-28", "end").toISOString(),
    ).toBe("2026-09-29T04:59:59.999Z");
  });

  it("starts a summer day at midnight Houston, not midnight UTC", () => {
    expect(
      zonedDayBoundary("2026-10-01", "start").toISOString(),
    ).toBe("2026-10-01T05:00:00.000Z");
  });

  it("shifts by an extra hour in winter, when the offset is UTC-6", () => {
    // The offset is not a constant. Hard-coding -5 would silently move every
    // winter promotion by an hour.
    expect(
      zonedDayBoundary("2026-01-15", "end").toISOString(),
    ).toBe("2026-01-16T05:59:59.999Z");
    expect(
      zonedDayBoundary("2026-01-15", "start").toISOString(),
    ).toBe("2026-01-15T06:00:00.000Z");
  });

  it("handles the spring-forward day, whose two ends have different offsets", () => {
    // 2026-03-08: starts at UTC-6, ends at UTC-5. A single-offset conversion
    // gets one of these two wrong whichever offset it picks.
    expect(
      zonedDayBoundary("2026-03-08", "start").toISOString(),
    ).toBe("2026-03-08T06:00:00.000Z");
    expect(
      zonedDayBoundary("2026-03-08", "end").toISOString(),
    ).toBe("2026-03-09T04:59:59.999Z");
  });

  it("handles the autumn fall-back day", () => {
    // 2026-11-01: starts at UTC-5, ends at UTC-6.
    expect(
      zonedDayBoundary("2026-11-01", "start").toISOString(),
    ).toBe("2026-11-01T05:00:00.000Z");
    expect(
      zonedDayBoundary("2026-11-01", "end").toISOString(),
    ).toBe("2026-11-02T05:59:59.999Z");
  });

  it("orders a same-day window correctly", () => {
    // The start and end of one calendar day must still bracket it, or a code
    // valid "today only" would be refused as a reversed range.
    const start = zonedDayBoundary("2026-06-15", "start");
    const end = zonedDayBoundary("2026-06-15", "end");

    expect(start.getTime()).toBeLessThan(end.getTime());
  });

  it("refuses a date that would silently roll over", () => {
    // new Date("2099-02-30") is not Invalid Date; it becomes March 2.
    expect(() => zonedDayBoundary("2099-02-30", "end")).toThrow();
    expect(() => zonedDayBoundary("2026-13-01", "end")).toThrow();
    expect(() => zonedDayBoundary("2026-00-10", "end")).toThrow();
    expect(() => zonedDayBoundary("2026-06-00", "end")).toThrow();
  });

  it("accepts a real leap day", () => {
    expect(
      zonedDayBoundary("2028-02-29", "start").toISOString(),
    ).toBe("2028-02-29T06:00:00.000Z");
  });
});

describe("zonedDateString", () => {
  it("renders the instant's Houston calendar date, not its UTC one", () => {
    // The round trip that matters: a day ends at 04:59Z the following day, so
    // slicing toISOString() would display the wrong date in the admin list.
    const end = zonedDayBoundary("2026-09-28", "end");

    expect(end.toISOString().slice(0, 10)).toBe("2026-09-29");
    expect(zonedDateString(end)).toBe("2026-09-28");
  });

  it("round-trips every boundary it is given", () => {
    for (const day of ["2026-01-15", "2026-03-08", "2026-06-15", "2026-11-01"]) {
      expect(zonedDateString(zonedDayBoundary(day, "start"))).toBe(day);
      expect(zonedDateString(zonedDayBoundary(day, "end"))).toBe(day);
    }
  });
});
