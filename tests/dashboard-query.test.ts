import { describe, expect, it } from "vitest";
import { resolveDashboardRanges } from "@/features/dashboard/dashboard-query";

const NEW_YORK = "America/New_York";
const REFERENCE_DATE = new Date("2026-06-15T18:00:00.000Z");

describe("dashboard URL query resolution", () => {
  it("maps a custom URL period to inclusive organization-local date boundaries", () => {
    const result = resolveDashboardRanges({
      period: "custom",
      startDate: "2026-06-10",
      endDate: "2026-06-12",
    }, NEW_YORK, REFERENCE_DATE);

    expect(result.period).toBe("custom");
    expect(result.todayRange.startUtc.toISOString()).toBe("2026-06-15T04:00:00.000Z");
    expect(result.range.startUtc.toISOString()).toBe("2026-06-10T04:00:00.000Z");
    expect(result.range.endExclusiveUtc.toISOString()).toBe("2026-06-13T04:00:00.000Z");
  });

  it("defaults missing input and fails closed from invalid period or custom dates", () => {
    const expectedToday = "2026-06-15T04:00:00.000Z";

    for (const searchParams of [
      {},
      { period: "week" },
      { period: "custom", startDate: "2026-02-30", endDate: "2026-03-01" },
      { period: ["today", "last7Days"] },
    ]) {
      const result = resolveDashboardRanges(searchParams, NEW_YORK, REFERENCE_DATE);
      expect(result.period).toBe("today");
      expect(result.range.startUtc.toISOString()).toBe(expectedToday);
      expect(result.range).toEqual(result.todayRange);
    }
  });
});
