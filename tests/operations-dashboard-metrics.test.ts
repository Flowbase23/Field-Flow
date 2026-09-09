/** Dashboard aggregate queries stay tenant-scoped at the mocked DB boundary. */
import { describe, expect, it, vi } from "vitest";
import {
  createOperationsDashboardMetricsService,
  type OperationsDashboardMetricsDb,
} from "@/server/services/operations-dashboard-metrics.service";

const ORGANIZATION_ID = "org-a";
const todayRange = {
  startUtc: new Date("2026-08-26T04:00:00.000Z"),
  endExclusiveUtc: new Date("2026-08-27T04:00:00.000Z"),
};
const range = {
  startUtc: new Date("2026-08-20T04:00:00.000Z"),
  endExclusiveUtc: new Date("2026-08-27T04:00:00.000Z"),
};

function makeDb(values: {
  appointments?: number[];
  jobs?: number[];
  revenue?: number | null;
  leads?: number[];
} = {}): OperationsDashboardMetricsDb {
  const appointmentCounts = values.appointments ?? [4, 2];
  const jobCounts = values.jobs ?? [3, 5];
  const leadCounts = values.leads ?? [2, 8];

  return {
    appointment: { count: vi.fn(async () => appointmentCounts.shift() ?? 0) },
    job: {
      count: vi.fn(async () => jobCounts.shift() ?? 0),
      aggregate: vi.fn(async () => ({
        _sum: { actualRevenueCents: values.revenue === undefined ? 12_550 : values.revenue },
      })),
    },
    lead: { count: vi.fn(async () => leadCounts.shift() ?? 0) },
  };
}

describe("operations dashboard metrics service", () => {
  it("uses separate tenant-scoped today and selected-period predicates for every aggregate", async () => {
    const db = makeDb();
    const metrics = await createOperationsDashboardMetricsService(db).getMetrics({
      organizationId: ORGANIZATION_ID,
      todayRange,
      range,
    });

    expect(metrics).toEqual({
      scheduledToday: 4,
      inProgress: 3,
      completedInRange: 5,
      completedJobRevenue: 12_550,
      avgTicket: 2_510,
      leadConversion: 0.25,
      missedInRange: 2,
    });
    expect(db.appointment.count).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: ORGANIZATION_ID,
        type: "JOB",
        status: { not: "CANCELLED" },
        startsAt: { lt: todayRange.endExclusiveUtc },
        endsAt: { gt: todayRange.startUtc },
      },
    });
    expect(db.job.count).toHaveBeenNthCalledWith(1, {
      where: { organizationId: ORGANIZATION_ID, status: "IN_PROGRESS" },
    });
    expect(db.job.count).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: ORGANIZATION_ID,
        completedAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
      },
    });
    // The aggregate path has its own tenant predicate; it cannot sum another tenant's revenue.
    expect(db.job.aggregate).toHaveBeenCalledWith({
      where: {
        organizationId: ORGANIZATION_ID,
        completedAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
      },
      _sum: { actualRevenueCents: true },
    });
    expect(db.appointment.count).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: ORGANIZATION_ID,
        status: "MISSED",
        startsAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
      },
    });
    expect(db.lead.count).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: ORGANIZATION_ID,
        status: "WON",
        wonAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
      },
    });
    expect(db.lead.count).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: ORGANIZATION_ID,
        createdAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
      },
    });
  });

  it("returns safe zeroes for empty aggregate data and a zero denominator", async () => {
    const db = makeDb({ appointments: [0, 0], jobs: [0, 0], revenue: null, leads: [0, 0] });

    await expect(
      createOperationsDashboardMetricsService(db).getMetrics({ organizationId: ORGANIZATION_ID, todayRange, range }),
    ).resolves.toEqual({
      scheduledToday: 0,
      inProgress: 0,
      completedInRange: 0,
      completedJobRevenue: 0,
      avgTicket: 0,
      leadConversion: 0,
      missedInRange: 0,
    });
  });
});
