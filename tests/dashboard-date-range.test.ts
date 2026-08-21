import { describe, expect, it } from "vitest";
import {
  parseDashboardPeriod,
  resolveDashboardDateRange,
} from "@/features/dashboard/date-range";

const NEW_YORK = "America/New_York";

describe("dashboard date ranges", () => {
  it("parses supported periods and resolves today using organization-local boundaries", () => {
    expect(parseDashboardPeriod("today")).toBe("today");
    expect(parseDashboardPeriod("last7Days")).toBe("last7Days");
    expect(parseDashboardPeriod("last30Days")).toBe("last30Days");
    expect(parseDashboardPeriod("custom")).toBe("custom");

    // 2026-06-15 is EDT (UTC-4), so New York's local day is [04:00Z, 04:00Z).
    const range = resolveDashboardDateRange({
      period: "today",
      timeZone: NEW_YORK,
      referenceDate: new Date("2026-06-15T18:00:00Z"),
    });

    expect(range.startUtc.toISOString()).toBe("2026-06-15T04:00:00.000Z");
    expect(range.endExclusiveUtc.toISOString()).toBe("2026-06-16T04:00:00.000Z");
  });

  it("preserves local calendar semantics across the spring DST boundary", () => {
    const range = resolveDashboardDateRange({
      period: "last7Days",
      timeZone: NEW_YORK,
      referenceDate: new Date("2026-03-10T16:00:00Z"), // Mar 10 local
    });

    // The inclusive local dates are Mar 4–10. Mar 8 is a 23-hour DST day.
    expect(range.startUtc.toISOString()).toBe("2026-03-04T05:00:00.000Z");
    expect(range.endExclusiveUtc.toISOString()).toBe("2026-03-11T04:00:00.000Z");
    expect(range.endExclusiveUtc.getTime() - range.startUtc.getTime()).toBe(167 * 3_600_000);
  });

  it("resolves inclusive custom local dates as a half-open UTC range", () => {
    const range = resolveDashboardDateRange({
      period: "custom",
      timeZone: NEW_YORK,
      customStartDate: "2026-11-01",
      customEndDate: "2026-11-02",
    });

    // Nov 1 is the 25-hour fall-back day in New York.
    expect(range.startUtc.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(range.endExclusiveUtc.toISOString()).toBe("2026-11-03T05:00:00.000Z");
  });

  it("rejects invalid periods, timezones, dates, and reversed custom ranges", () => {
    expect(() => parseDashboardPeriod("week")).toThrow(/must be one of/);
    expect(() => resolveDashboardDateRange({ period: "today", timeZone: "Mars/Olympus" })).toThrow(/valid IANA timezone/);
    expect(() => resolveDashboardDateRange({
      period: "custom",
      timeZone: NEW_YORK,
      customStartDate: "2026-02-30",
      customEndDate: "2026-03-01",
    })).toThrow(/valid YYYY-MM-DD/);
    expect(() => resolveDashboardDateRange({
      period: "custom",
      timeZone: NEW_YORK,
      customStartDate: "2026-06-16",
      customEndDate: "2026-06-15",
    })).toThrow(/must not be after/);
  });
});
