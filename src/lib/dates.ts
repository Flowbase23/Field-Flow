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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
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

/**
 * UTC instant of 00:00:00.000 on `date`'s calendar day in `timeZone`.
 *
 * NOTE (Slice 4 bug fix): this is the true UTC instant of LOCAL midnight —
 * e.g. for America/New_York in summer that is 04:00Z, not 00:00Z. The original
 * implementation built `Date.UTC(y, m-1, d)` (naive UTC midnight), which made
 * day ranges drift by the zone offset; every consumer (orgDayRange, schedule
 * views, dashboard KPI windows) relies on the offset-aware behavior.
 */
export function startOfDayInTz(date: Date, timeZone: string): Date {
  const { year, month, day } = datePartsInTz(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return localDateTimeToUtc(`${year}-${pad(month)}-${pad(day)}T00:00`, timeZone);
}

/** UTC instant of 23:59:59.999 on `date`'s calendar day in `timeZone` (DST-correct via local-day stepping). */
export function endOfDayInTz(date: Date, timeZone: string): Date {
  const start = startOfDayInTz(date, timeZone);
  return new Date(nextDayInTz(start, timeZone).getTime() - 1);
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

// ─── Slice 4 additions: appointment/calendar timezone math ────────────────────
//
// Scheduling model (design §8.2): input times are wall-clock values in an
// explicit IANA timezone (the appointment's own timezone, defaulting to the
// org's); they are converted to UTC for storage and back to the org/location
// timezone for display. All conversions below go through Intl.DateTimeFormat,
// so they are DST-correct for any zone the runtime supports.

export interface TimeParts extends DateParts {
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

/** Full wall-clock parts of `date` in `timeZone` (DST-aware, hourCycle h23). */
export function timePartsInTz(date: Date, timeZone: string): TimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    const value = part ? Number(part.value) : NaN;
    if (!Number.isInteger(value)) {
      throw new Error(`Intl.DateTimeFormat did not produce a ${type} part for "${timeZone}".`);
    }
    return value;
  };
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"), second: get("second"),
  };
}

const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Convert a wall-clock datetime ("YYYY-MM-DDTHH:mm" or with :ss — the value of
 * an <input type="datetime-local">) in `timeZone` to the UTC instant.
 *
 * DST policy (documented in the README, Slice 4): ambiguous fall-back times
 * resolve to the FIRST (earlier, DST) occurrence; nonexistent spring-forward
 * times roll forward to the post-transition offset. The offset is solved by
 * fixed-point iteration on Intl wall-clock parts, which converges in ≤2 steps.
 */
export function localDateTimeToUtc(localIso: string, timeZone: string): Date {
  const match = LOCAL_DATETIME_RE.exec(localIso.trim());
  if (!match) {
    throw new Error(`localDateTimeToUtc: "${localIso}" is not a YYYY-MM-DDTHH:mm datetime.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`localDateTimeToUtc: "${localIso}" has out-of-range components.`);
  }
  const targetWallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  // offset(tz, instant) = wallClockAsUtc(instant) - instant.
  // desired instant = targetWall - offset(guess); iterate until stable.
  let instant = targetWallMs;
  for (let i = 0; i < 3; i++) {
    const wall = timePartsInTz(new Date(instant), timeZone);
    const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    const next = targetWallMs - (wallAsUtc - instant);
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

/** Format a UTC Date as "YYYY-MM-DDTHH:mm" wall-clock in `timeZone` (for datetime-local inputs). */
export function utcToLocalDateTime(date: Date, timeZone: string): string {
  const p = timePartsInTz(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Add whole days to a UTC instant (wall-clock-agnostic; use nextDayInTz for local-day stepping). */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** The next local midnight after `dayStartUtc` (which must be a local midnight in `timeZone`). */
export function nextDayInTz(dayStartUtc: Date, timeZone: string): Date {
  const p = datePartsInTz(dayStartUtc, timeZone);
  // Noon is DST-unambiguous; take local midnight of the following local day.
  const noon = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
  return startOfDayInTz(addDays(noon, 1), timeZone);
}

/** UTC instant of local midnight on the first day of the week containing `date`. */
export function startOfWeekInTz(date: Date, timeZone: string, weekStartsOn = 1): Date {
  const p = datePartsInTz(date, timeZone);
  const localNoon = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
  const weekday = localNoon.getUTCDay(); // 0 = Sunday
  const diff = (weekday - weekStartsOn + 7) % 7;
  return startOfDayInTz(addDays(localNoon, -diff), timeZone);
}

/** UTC instant of the last millisecond of the week containing `date` (DST-correct). */
export function endOfWeekInTz(date: Date, timeZone: string, weekStartsOn = 1): Date {
  const start = startOfWeekInTz(date, timeZone, weekStartsOn);
  // The week ends at the NEXT week's start (7 LOCAL days later) minus 1ms —
  // i.e. Sunday 23:59:59.999 local, which is DST-correct (a 23h/25h Sunday).
  return new Date(addLocalDaysInTz(start, 7, timeZone).getTime() - 1);
}

/** Step `days` LOCAL days forward from a local midnight (DST-correct day stepping). */
function addLocalDaysInTz(dayStartUtc: Date, days: number, timeZone: string): Date {
  let cursor = dayStartUtc;
  for (let i = 0; i < days; i++) {
    cursor = nextDayInTz(cursor, timeZone);
  }
  return cursor;
}

/** True when `a` and `b` fall on the same calendar day in `timeZone`. */
export function sameDayInTz(a: Date, b: Date, timeZone: string): boolean {
  const pa = datePartsInTz(a, timeZone);
  const pb = datePartsInTz(b, timeZone);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/** Minutes from local midnight to `date` (0–1439.99) — used for day-view positioning. */
export function minutesFromDayStartInTz(date: Date, timeZone: string): number {
  const p = timePartsInTz(date, timeZone);
  return p.hour * 60 + p.minute + p.second / 60;
}

/** Short time label, e.g. "9:30 AM". */
export function formatTimeInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

/** Short day label, e.g. "Wed, Aug 5". */
export function formatDayInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(date);
}

/** Full weekday name, e.g. "Wednesday". */
export function formatWeekdayInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(date);
}

/**
 * Month grid: weeks (Monday-first) covering `date`'s month, each cell the UTC
 * instant of local midnight for that day. Cells include leading/trailing days
 * from adjacent months so every week row is complete. DST-correct day stepping.
 */
export function monthGridInTz(date: Date, timeZone: string): Date[][] {
  const { year, month } = datePartsInTz(date, timeZone);
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
  const lastOfMonth = new Date(Date.UTC(year, month, 0, 12, 0, 0));
  let cursor = startOfWeekInTz(firstOfMonth, timeZone, 1);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(cursor);
      cursor = nextDayInTz(cursor, timeZone);
    }
    weeks.push(week);
    if (cursor.getTime() > lastOfMonth.getTime()) break;
  }
  return weeks;
}
