/**
 * Tenant-scoped aggregate reads for the Phase 1 operations dashboard.
 *
 * The caller supplies an already-resolved, organization-local UTC date range
 * from `resolveDashboardDateRange`; this service does not accept browser input
 * or calculate timezone boundaries itself. Every aggregate includes the tenant
 * predicate at the query boundary.
 */
import type { DashboardDateRange } from "@/features/dashboard/date-range";

/** Minimal Prisma-shaped read boundary, kept small for focused unit tests. */
export interface OperationsDashboardMetricsDb {
  job: { count(args: { where: Record<string, unknown> }): Promise<number> };
  appointment: { count(args: { where: Record<string, unknown> }): Promise<number> };
}

export interface OperationsDashboardMetricsInput {
  /** Trusted server-side organization id, originating from requireOrg(). */
  organizationId: string;
  /** UTC half-open range resolved using the organization's IANA timezone. */
  range: DashboardDateRange;
}

export interface OperationsDashboardMetrics {
  /** JOB appointments that overlap the supplied organization-local today range. */
  scheduledToday: number;
  /** Jobs currently in progress, regardless of the selected reporting range. */
  inProgress: number;
  /** Jobs whose completedAt is in [startUtc, endExclusiveUtc). */
  completedInRange: number;
  /** Appointments marked MISSED whose startsAt is in [startUtc, endExclusiveUtc). */
  missedInRange: number;
}

/**
 * Create the dashboard aggregate reader at the database boundary.
 *
 * `range` is intentionally trusted: route/server-action code must validate the
 * period and resolve it with `resolveDashboardDateRange` before calling this
 * service. Scheduled-today uses that same range when the caller resolves the
 * `today` period; selected-range metrics use it for their reporting period.
 */
export function createOperationsDashboardMetricsService(db: OperationsDashboardMetricsDb) {
  return {
    async getMetrics({ organizationId, range }: OperationsDashboardMetricsInput): Promise<OperationsDashboardMetrics> {
      const [scheduledToday, inProgress, completedInRange, missedInRange] = await Promise.all([
        db.appointment.count({
          where: {
            organizationId,
            type: "JOB",
            status: { not: "CANCELLED" },
            startsAt: { lt: range.endExclusiveUtc },
            endsAt: { gt: range.startUtc },
          },
        }),
        db.job.count({
          where: { organizationId, status: "IN_PROGRESS" },
        }),
        db.job.count({
          where: {
            organizationId,
            completedAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
          },
        }),
        db.appointment.count({
          where: {
            organizationId,
            status: "MISSED",
            startsAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
          },
        }),
      ]);

      return {
        scheduledToday: safeCount(scheduledToday),
        inProgress: safeCount(inProgress),
        completedInRange: safeCount(completedInRange),
        missedInRange: safeCount(missedInRange),
      };
    },
  };
}

/** Prisma counts are non-negative integers; preserve that contract at this seam. */
function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
