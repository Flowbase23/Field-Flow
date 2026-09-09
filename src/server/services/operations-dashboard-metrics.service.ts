/**
 * Tenant-scoped aggregate reads for the Phase 1 operations dashboard.
 *
 * The caller supplies already-resolved, organization-local UTC date ranges from
 * `resolveDashboardDateRange`; this service does not accept browser input or
 * calculate timezone boundaries itself. Every aggregate includes the tenant
 * predicate at the query boundary.
 */
import type { DashboardDateRange } from "@/features/dashboard/date-range";

/** Minimal Prisma-shaped read boundary, kept small for focused unit tests. */
export interface OperationsDashboardMetricsDb {
  job: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
    aggregate(args: {
      where: Record<string, unknown>;
      _sum: { actualRevenueCents: true };
    }): Promise<{ _sum: { actualRevenueCents: number | null } }>;
  };
  appointment: { count(args: { where: Record<string, unknown> }): Promise<number> };
  lead: { count(args: { where: Record<string, unknown> }): Promise<number> };
}

export interface OperationsDashboardMetricsInput {
  /** Trusted server-side organization id, originating from requireOrg(). */
  organizationId: string;
  /** UTC half-open organization-local today range, used only by scheduledToday. */
  todayRange: DashboardDateRange;
  /** UTC half-open range for selected-period aggregates. */
  range: DashboardDateRange;
}

export interface OperationsDashboardMetrics {
  /** JOB appointments not cancelled that overlap the organization-local today range. */
  scheduledToday: number;
  /** Jobs currently in progress, regardless of the selected reporting range. */
  inProgress: number;
  /** Jobs whose completedAt is in the selected [startUtc, endExclusiveUtc) range. */
  completedInRange: number;
  /** Sum, in integer cents, of actualRevenueCents for jobs completed in the selected range. */
  completedJobRevenue: number;
  /** completedJobRevenue divided by completedInRange, rounded to the nearest integer cent. */
  avgTicket: number;
  /** WON leads in the selected range divided by leads created in that range; zero when none were created. */
  leadConversion: number;
  /** Appointments marked MISSED whose startsAt is in the selected range. */
  missedInRange: number;
}

/**
 * Create the dashboard aggregate reader at the database boundary.
 *
 * `todayRange` and `range` are intentionally trusted: route/server-action code
 * must validate URL input and resolve them with the organization's IANA timezone
 * before calling this service. Keeping them separate prevents a selected
 * last-7/last-30/custom period from changing the scheduled-today KPI.
 */
export function createOperationsDashboardMetricsService(db: OperationsDashboardMetricsDb) {
  return {
    async getMetrics({
      organizationId,
      todayRange,
      range,
    }: OperationsDashboardMetricsInput): Promise<OperationsDashboardMetrics> {
      const completedWhere = {
        organizationId,
        completedAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
      };

      const [
        scheduledToday,
        inProgress,
        completedInRange,
        completedRevenue,
        missedInRange,
        wonLeadsInRange,
        leadsCreatedInRange,
      ] = await Promise.all([
        db.appointment.count({
          where: {
            organizationId,
            type: "JOB",
            status: { not: "CANCELLED" },
            startsAt: { lt: todayRange.endExclusiveUtc },
            endsAt: { gt: todayRange.startUtc },
          },
        }),
        db.job.count({
          where: { organizationId, status: "IN_PROGRESS" },
        }),
        db.job.count({ where: completedWhere }),
        // "completed-job revenue" is the engineering working assumption pending owner confirmation.
        db.job.aggregate({
          where: completedWhere,
          _sum: { actualRevenueCents: true },
        }),
        db.appointment.count({
          where: {
            organizationId,
            status: "MISSED",
            startsAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
          },
        }),
        db.lead.count({
          where: {
            organizationId,
            status: "WON",
            wonAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
          },
        }),
        db.lead.count({
          where: {
            organizationId,
            createdAt: { gte: range.startUtc, lt: range.endExclusiveUtc },
          },
        }),
      ]);

      const completedCount = safeCount(completedInRange);
      const completedJobRevenue = safeCents(completedRevenue._sum.actualRevenueCents);
      const createdLeadCount = safeCount(leadsCreatedInRange);

      return {
        scheduledToday: safeCount(scheduledToday),
        inProgress: safeCount(inProgress),
        completedInRange: completedCount,
        completedJobRevenue,
        avgTicket: completedCount === 0 ? 0 : Math.round(completedJobRevenue / completedCount),
        leadConversion: createdLeadCount === 0 ? 0 : safeCount(wonLeadsInRange) / createdLeadCount,
        missedInRange: safeCount(missedInRange),
      };
    },
  };
}

/** Prisma counts are non-negative integers; preserve that contract at this seam. */
function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Prisma returns null for an empty sum; dashboard monetary values remain integer cents. */
function safeCents(value: number | null): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
}
