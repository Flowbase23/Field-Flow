/** Dashboard aggregate queries stay tenant-scoped at the mocked DB boundary. */
import { describe, expect, it, vi } from "vitest";
import {
  createOperationsDashboardMetricsService,
  type OperationsDashboardMetricsDb,
} from "@/server/services/operations-dashboard-metrics.service";

const ORGANIZATION_ID = "org-a";
const range = {
  startUtc: new Date("2026-08-26T04:00:00.000Z"),
  endExclusiveUtc: new Date("2026-08-27T04:00:00.000Z"),
};

function makeDb(counts: { appointments?: number[]; jobs?: number[] } = {}): OperationsDashboardMetricsDb {
  const appointmentCounts = counts.appointments ?? [4, 2];
  const jobCounts = counts.jobs ?? [3, 5];
  return {
    appointment: { count: vi.fn(async () => appointmentCounts.shift() ?? 0) },
    job: { count: vi.fn(async () => jobCounts.shift() ?? 0) },
  };
}

describe("operations dashboard metrics service", () => {
  it("uses tenant-scoped status and UTC range predicates for all four aggregates", async () => {
    const db = makeDb();
    const metrics = await createOperationsDashboardMetricsService(db).getMetrics({
      organizationId: ORGANIZATION_ID,
      range,
    });

    expect(metrics).toEqual({
      scheduledToday: 4,
      inProgress: 3,
      completedInRange: 5,
      missedInRange: 2,
    });
    expect(db.appointment.count).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId: ORGANIZATION_ID,
        type: "JOB",
        status: { not: "CANCELLED" },
        startsAt: { lt: range.endExclusiveUtc },
        endsAt: { gt: range.startUtc },
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
    expect(db.appointment.count).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: ORGANIZATION_ID,
        status: "MISSED",
        startsAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
      },
    });
  });

  it("returns safe zero counts when the aggregate queries find no records", async () => {
    const db = makeDb({ appointments: [0, 0], jobs: [0, 0] });

    await expect(
      createOperationsDashboardMetricsService(db).getMetrics({ organizationId: ORGANIZATION_ID, range }),
    ).resolves.toEqual({
      scheduledToday: 0,
      inProgress: 0,
      completedInRange: 0,
      missedInRange: 0,
    });
  });
});
