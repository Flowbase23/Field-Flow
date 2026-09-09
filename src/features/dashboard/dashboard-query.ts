import {
  parseDashboardPeriod,
  resolveDashboardDateRange,
  type DashboardDateRange,
  type DashboardPeriod,
} from "./date-range";

/** Query shape supplied by a Next.js App Router page. Duplicate values fail closed. */
export interface DashboardSearchParams {
  period?: string | string[];
  startDate?: string | string[];
  endDate?: string | string[];
}

export interface ResolvedDashboardRanges {
  period: DashboardPeriod;
  todayRange: DashboardDateRange;
  range: DashboardDateRange;
}

/**
 * Resolve dashboard URL parameters with one shared reference instant.
 *
 * Invalid period/custom-date input intentionally falls back to the organization-
 * local today range rather than expanding the report or throwing from the page.
 */
export function resolveDashboardRanges(
  searchParams: DashboardSearchParams,
  timeZone: string,
  referenceDate = new Date(),
): ResolvedDashboardRanges {
  const todayRange = resolveDashboardDateRange({
    period: "today",
    timeZone,
    referenceDate,
  });

  try {
    const period = parseDashboardPeriod(singleValue(searchParams.period) ?? "today");
    const range = resolveDashboardDateRange({
      period,
      timeZone,
      referenceDate,
      customStartDate: singleValue(searchParams.startDate),
      customEndDate: singleValue(searchParams.endDate),
    });

    return { period, todayRange, range };
  } catch {
    return { period: "today", todayRange, range: todayRange };
  }
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
