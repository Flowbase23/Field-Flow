/**
 * Timezone-safe date helpers.
 *
 * Convention (design §3 notes + §8.2): ALL timestamps are stored in UTC.
 * "Day boundaries" for org reporting (dashboard KPIs, schedule views) are computed
 * from the organization's timezone (Organization.timezone, display default) or a
 * location/appointment timezone override — never from the server's local time,
 * never from naive date strings.
 *
 * Implementation uses Intl.DateTimeFormat with the requested timeZone, so it is
 * DST-correct for any IANA zone supported by the runtime.
 */

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", // overridden per call
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * The calendar date (year/month/day) that `date` falls on in `timeZone`.
 * Pure — does not depend on the server's timezone.
 */
export function datePartsInTz(date: Date, timeZone: string): DateParts {
  // formatToParts is locale/format stable; we only read the parts by type.
  const parts = partsFormatter.formatToParts(date);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    const value = part ? Number(part.value) : NaN;
    if (!Number.isInteger(value)) {
      throw new Error(`Intl.DateTimeFormat did not produce a ${type} part for "${timeZone}".`);
    }
    return value;
  };
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** UTC instant of 00:00:00.000 on `date`'s calendar day in `timeZone`. */
export function startOfDayInTz(date: Date, timeZone: string): Date {
  const { year, month, day } = datePartsInTz(date, timeZone);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

/** UTC instant of 23:59:59.999 on `date`'s calendar day in `timeZone`. */
export function endOfDayInTz(date: Date, timeZone: string): Date {
  const start = startOfDayInTz(date, timeZone);
  return new Date(start.getTime() + 86_400_000 - 1);
}

/** Inclusive [start, end] range for "today" in `timeZone`. */
export function orgDayRange(
  timeZone: string,
  now: Date = new Date(),
): { start: Date; end: Date } {
  return { start: startOfDayInTz(now, timeZone), end: endOfDayInTz(now, timeZone) };
}

export type DateStyle = "short" | "medium" | "long";

/** Format a UTC Date for display in `timeZone`. */
export function formatDateInTz(date: Date, timeZone: string, style: DateStyle = "medium"): string {
  const options: Intl.DateTimeFormatOptions =
    style === "short"
      ? { timeZone, dateStyle: "short" }
      : style === "long"
        ? { timeZone, dateStyle: "long", timeStyle: "short" }
        : { timeZone, dateStyle: "medium", timeStyle: "short" };
  return new Intl.DateTimeFormat("en-US", options).format(date);
}
