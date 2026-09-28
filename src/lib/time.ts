import { BUSINESS } from "@/lib/business";

/**
 * Calendar days resolved in the shop's timezone.
 *
 * A `<input type="date">` submits "YYYY-MM-DD" with no timezone, and an admin
 * who types it means a day in Houston, not a day in UTC. Resolving it as UTC
 * looks right and is not: anchoring "ends 28 September" at 23:59:59.999Z ends
 * the promotion at 6:59pm local, five hours early, and an admin creating a
 * code after 7pm with "ends today" gets one that is born expired. Anchoring a
 * start at 00:00:00Z has the mirror problem -- an embargoed code goes live the
 * previous evening.
 *
 * The offset is read from Intl per date rather than hard-coded, because it is
 * not a constant: Houston is UTC-5 in summer and UTC-6 in winter, and the two
 * ends of a DST transition day have different offsets from each other.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The offset from UTC, in milliseconds, in effect in `timeZone` at `instant`.
 * Negative west of Greenwich, so Houston in summer is -5h.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const at: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") at[part.type] = Number(part.value);
  }

  const wallClock = Date.UTC(
    at.year,
    at.month - 1,
    at.day,
    // `hour12: false` reports midnight as hour 24 in some engines.
    at.hour % 24,
    at.minute,
    at.second,
  );

  // Compare whole seconds: formatToParts has no millisecond field, so the
  // instant's own milliseconds would otherwise show up as offset drift.
  return wallClock - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The first or last instant of a calendar day in the shop's timezone.
 *
 * Throws on a date that is not real. `new Date("2099-02-30")` does not produce
 * Invalid Date -- it rolls forward to March 2 -- so a malformed date would
 * otherwise become a different, valid one without anyone noticing.
 */
export function zonedDayBoundary(
  dateOnly: string,
  boundary: "start" | "end",
  timeZone: string = BUSINESS.timeZone,
): Date {
  const match = DATE_ONLY.exec(dateOnly);
  if (!match) throw new RangeError(`Not a YYYY-MM-DD date: ${dateOnly}`);

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    throw new RangeError(`Not a real calendar date: ${dateOnly}`);
  }

  const wallClock =
    boundary === "start"
      ? Date.UTC(year, month - 1, day, 0, 0, 0, 0)
      : Date.UTC(year, month - 1, day, 23, 59, 59, 999);

  // Guess using the offset at the wall-clock instant, then correct once. On a
  // DST transition day the offset on the far side of the guess differs, and
  // without the second pass one end of that day lands an hour out.
  const guess = wallClock - zoneOffsetMs(new Date(wallClock), timeZone);
  const corrected = wallClock - zoneOffsetMs(new Date(guess), timeZone);

  return new Date(corrected);
}

/** An instant's calendar date ("YYYY-MM-DD") in the shop's timezone. */
export function zonedDateString(
  instant: Date,
  timeZone: string = BUSINESS.timeZone,
): string {
  // en-CA formats as YYYY-MM-DD, which is the format the date inputs use.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
