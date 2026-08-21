import {
  addDays,
  datePartsInTz,
  localDateTimeToUtc,
  nextDayInTz,
  startOfDayInTz,
} from "@/lib/dates";

/** Dashboard reporting periods supported by the API and UI. */
export type DashboardPeriod = "today" | "last7Days" | "last30Days" | "custom";

/** A UTC half-open interval whose endpoints are organization-local midnights. */
export interface DashboardDateRange {
  startUtc: Date;
  endExclusiveUtc: Date;
}

export interface DashboardDateRangeInput {
  period: unknown;
  timeZone: string;
  referenceDate?: Date;
  customStartDate?: string;
  customEndDate?: string;
}

const DASHBOARD_PERIODS = new Set<DashboardPeriod>([
  "today",
  "last7Days",
  "last30Days",
  "custom",
]);

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse untrusted period input into the only period values the dashboard supports. */
export function parseDashboardPeriod(input: unknown): DashboardPeriod {
  if (typeof input === "string" && DASHBOARD_PERIODS.has(input as DashboardPeriod)) {
    return input as DashboardPeriod;
  }

  throw new Error("Dashboard period must be one of: today, last7Days, last30Days, custom.");
}

/**
 * Resolve a dashboard period to a UTC half-open interval. Calendar boundaries are
 * calculated in the organization's IANA timezone, so a DST day may be 23 or 25 hours.
 * `last7Days` and `last30Days` include the organization-local reference day.
 */
export function resolveDashboardDateRange({
  period: periodInput,
  timeZone,
  referenceDate = new Date(),
  customStartDate,
  customEndDate,
}: DashboardDateRangeInput): DashboardDateRange {
  const period = parseDashboardPeriod(periodInput);
  assertValidTimeZone(timeZone);
  assertValidReferenceDate(referenceDate);

  if (period === "custom") {
    const startUtc = customDateStart(customStartDate, timeZone, "start");
    const endStartUtc = customDateStart(customEndDate, timeZone, "end");

    if (startUtc.getTime() > endStartUtc.getTime()) {
      throw new Error("Dashboard custom range start date must not be after end date.");
    }

    return { startUtc, endExclusiveUtc: nextDayInTz(endStartUtc, timeZone) };
  }

  const todayStartUtc = startOfDayInTz(referenceDate, timeZone);
  const daysIncluded = period === "today" ? 1 : period === "last7Days" ? 7 : 30;
  const startUtc = daysIncluded === 1
    ? todayStartUtc
    : startOfDayInTz(localDateOffset(referenceDate, timeZone, -(daysIncluded - 1)), timeZone);

  return { startUtc, endExclusiveUtc: nextDayInTz(todayStartUtc, timeZone) };
}

function assertValidTimeZone(timeZone: string): void {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new Error("Dashboard timezone must be a valid IANA timezone.");
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`Dashboard timezone "${timeZone}" is not a valid IANA timezone.`);
  }
}

function assertValidReferenceDate(referenceDate: Date): void {
  if (!(referenceDate instanceof Date) || Number.isNaN(referenceDate.getTime())) {
    throw new Error("Dashboard reference date must be a valid Date.");
  }
}

function customDateStart(value: string | undefined, timeZone: string, label: "start" | "end"): Date {
  if (typeof value !== "string" || !isCalendarDate(value)) {
    throw new Error(`Dashboard custom ${label} date must be a valid YYYY-MM-DD date.`);
  }

  return localDateTimeToUtc(`${value}T00:00`, timeZone);
}

function isCalendarDate(value: string): boolean {
  const match = LOCAL_DATE_RE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const daysInMonth = month === 2
    ? (isLeapYear(year) ? 29 : 28)
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;
  return day <= daysInMonth;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Return a UTC instant safely representing a local calendar day offset from `referenceDate`. */
function localDateOffset(referenceDate: Date, timeZone: string, days: number): Date {
  const { year, month, day } = datePartsInTz(referenceDate, timeZone);
  // UTC noon avoids the time-zone offset when deriving a neighboring calendar date.
  return addDays(new Date(Date.UTC(year, month - 1, day, 12)), days);
}
