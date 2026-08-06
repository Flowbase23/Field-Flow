/**
 * Timezone/DST tests for the scheduling date helpers (Phase 1, Slice 4).
 *
 * Covers the DST boundaries the schedule must survive:
 *   - spring forward (America/New_York 2026-03-08: 02:00 EST → 03:00 EDT, a 23h day)
 *   - fall back    (America/New_York 2026-11-01: 02:00 EDT → 01:00 EST, a 25h day)
 * plus local→UTC conversion round trips, ambiguous/nonexistent local times,
 * and the calendar grid math (week start, month grid, day stepping).
 *
 * All expectations are in UTC instants (the storage format, design §3 notes).
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  datePartsInTz,
  endOfDayInTz,
  endOfWeekInTz,
  formatDayInTz,
  formatTimeInTz,
  localDateTimeToUtc,
  minutesFromDayStartInTz,
  monthGridInTz,
  nextDayInTz,
  orgDayRange,
  sameDayInTz,
  startOfDayInTz,
  startOfWeekInTz,
  timePartsInTz,
  utcToLocalDateTime,
} from "@/lib/dates";

const NY = "America/New_York";

describe("orgDayRange across DST boundaries", () => {
  it("spring forward: March 8 2026 is a 23-hour day in New York", () => {
    // 2026-03-08 00:00 EST = 05:00Z; the next local midnight is 04:00Z (EDT).
    const day = startOfDayInTz(new Date("2026-03-08T12:00:00Z"), NY);
    expect(day.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    const next = nextDayInTz(day, NY);
    expect(next.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    // orgDayRange must span exactly 23 hours (86_400_000 - 3_600_000).
    const range = orgDayRange(NY, new Date("2026-03-08T15:00:00Z"));
    expect(range.end.getTime() - range.start.getTime()).toBe(23 * 3_600_000 - 1);
    expect(endOfDayInTz(new Date("2026-03-08T12:00:00Z"), NY).toISOString()).toBe("2026-03-09T03:59:59.999Z");
  });

  it("fall back: November 1 2026 is a 25-hour day in New York", () => {
    // 2026-11-01 00:00 EDT = 04:00Z; the next local midnight is 05:00Z (EST).
    const day = startOfDayInTz(new Date("2026-11-01T12:00:00Z"), NY);
    expect(day.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    const next = nextDayInTz(day, NY);
    expect(next.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    const range = orgDayRange(NY, new Date("2026-11-01T15:00:00Z"));
    expect(range.end.getTime() - range.start.getTime()).toBe(25 * 3_600_000 - 1);
  });

  it("a regular day is 24 hours", () => {
    const range = orgDayRange(NY, new Date("2026-06-15T12:00:00Z"));
    expect(range.end.getTime() - range.start.getTime()).toBe(24 * 3_600_000 - 1);
    // June is EDT (-4): local midnight 04:00Z.
    expect(range.start.toISOString()).toBe("2026-06-15T04:00:00.000Z");
  });
});

describe("localDateTimeToUtc (wall clock → UTC)", () => {
  it("converts a normal morning correctly", () => {
    // 2026-06-15 09:30 EDT = 13:30Z.
    expect(localDateTimeToUtc("2026-06-15T09:30", NY).toISOString()).toBe("2026-06-15T13:30:00.000Z");
  });

  it("is DST-correct before and after spring forward at the same wall time", () => {
    // Before (EST, -5): 09:30 → 14:30Z.
    expect(localDateTimeToUtc("2026-03-06T09:30", NY).toISOString()).toBe("2026-03-06T14:30:00.000Z");
    // After (EDT, -4): 09:30 → 13:30Z.
    expect(localDateTimeToUtc("2026-03-09T09:30", NY).toISOString()).toBe("2026-03-09T13:30:00.000Z");
  });

  it("resolves the nonexistent 02:30 spring-forward time to the post-transition offset", () => {
    // 02:30 on 2026-03-08 does not exist; policy: roll forward → 03:30 EDT = 07:30Z.
    expect(localDateTimeToUtc("2026-03-08T02:30", NY).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("resolves ambiguous 01:30 fall-back time to the first (DST) occurrence", () => {
    // 01:30 on 2026-11-01 happens twice; policy: first occurrence = 01:30 EDT = 05:30Z.
    expect(localDateTimeToUtc("2026-11-01T01:30", NY).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("round-trips through utcToLocalDateTime on both sides of each boundary", () => {
    for (const wall of ["2026-03-06T09:30", "2026-03-09T09:30", "2026-11-01T09:30", "2026-11-02T09:30", "2026-06-15T00:00", "2026-06-15T23:59"]) {
      const utc = localDateTimeToUtc(wall, NY);
      expect(utcToLocalDateTime(utc, NY)).toBe(wall);
    }
  });

  it("handles seconds and rejects garbage", () => {
    expect(localDateTimeToUtc("2026-06-15T09:30:45", NY).toISOString()).toBe("2026-06-15T13:30:45.000Z");
    expect(() => localDateTimeToUtc("not-a-date", NY)).toThrow(/not a YYYY-MM-DDTHH:mm/);
    expect(() => localDateTimeToUtc("2026-13-40T25:99", NY)).toThrow(/out-of-range/);
  });
});

describe("calendar grid helpers", () => {
  it("startOfWeekInTz is Monday-first and DST-safe", () => {
    // 2026-03-04 is a Wednesday; the week starts Mon 2026-03-02 05:00Z (EST).
    const week = startOfWeekInTz(new Date("2026-03-04T12:00:00Z"), NY);
    expect(week.toISOString()).toBe("2026-03-02T05:00:00.000Z");
    // Week containing Nov 1 (Sunday): starts Mon Oct 26 at 04:00Z (EDT).
    const fallWeek = startOfWeekInTz(new Date("2026-11-01T12:00:00Z"), NY);
    expect(fallWeek.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    const end = endOfWeekInTz(new Date("2026-03-04T12:00:00Z"), NY);
    // Sunday Mar 8 is a 23h day (spring forward at 2am): the week ends Sunday
    // 23:59:59.999 EDT = Mon Mar 9 03:59:59.999Z, spanning 6×24h + 23h - 1ms.
    expect(end.toISOString()).toBe("2026-03-09T03:59:59.999Z");
    expect(end.getTime() - week.getTime()).toBe(6 * 3_600_000 * 24 + 23 * 3_600_000 - 1);
    // Fall-back week (Oct 26 – Nov 1): Nov 1 is a 25h day → week spans 6×24h + 25h - 1ms.
    const fallEnd = endOfWeekInTz(new Date("2026-11-01T12:00:00Z"), NY);
    expect(fallEnd.toISOString()).toBe("2026-11-02T04:59:59.999Z");
    expect(fallEnd.getTime() - fallWeek.getTime()).toBe(6 * 3_600_000 * 24 + 25 * 3_600_000 - 1);
  });

  it("nextDayInTz steps correctly across both DST boundaries", () => {
    let cursor = startOfDayInTz(new Date("2026-03-07T12:00:00Z"), NY); // Sat Mar 7, EST
    const days: string[] = [];
    for (let i = 0; i < 3; i++) {
      days.push(cursor.toISOString());
      cursor = nextDayInTz(cursor, NY);
    }
    expect(days).toEqual([
      "2026-03-07T05:00:00.000Z", // Sat (EST)
      "2026-03-08T05:00:00.000Z", // Sun (EST → EDT)
      "2026-03-09T04:00:00.000Z", // Mon (EDT)
    ]);
  });

  it("monthGridInTz produces complete Monday-first weeks covering the month", () => {
    // March 2026 starts on Sunday and has 31 days (ends Tue Mar 31), so the grid
    // spans Mon Feb 23 → Sun Apr 5: 6 complete weeks.
    const grid = monthGridInTz(new Date("2026-03-15T12:00:00Z"), NY);
    expect(grid.length).toBe(6);
    expect(grid[0].length).toBe(7);
    expect(grid[0][0].toISOString()).toBe("2026-02-23T05:00:00.000Z");
    expect(grid[4][6].toISOString()).toBe("2026-03-29T04:00:00.000Z");
    expect(grid[5][6].toISOString()).toBe("2026-04-05T04:00:00.000Z");
    // Every week's Monday is a local midnight (00:00 local, any day-of-month).
    for (const week of grid) {
      expect(timePartsInTz(week[0], NY).hour).toBe(0);
      expect(week.length).toBe(7);
      for (const day of week) {
        expect(timePartsInTz(day, NY).hour).toBe(0); // every cell is a local midnight
      }
    }
  });

  it("sameDayInTz / minutesFromDayStartInTz / labels", () => {
    const morning = localDateTimeToUtc("2026-03-09T09:30", NY); // EDT day
    expect(minutesFromDayStartInTz(morning, NY)).toBe(570);
    expect(sameDayInTz(morning, addDays(morning, 1), NY)).toBe(false);
    expect(sameDayInTz(morning, new Date(morning.getTime() + 60_000), NY)).toBe(true);
    expect(formatTimeInTz(morning, NY)).toBe("9:30 AM");
    expect(formatDayInTz(morning, NY)).toBe("Mon, Mar 9");
  });
});
