import { Permission } from "@prisma/client";
import { DashboardOverview } from "@/features/dashboard/dashboard-overview";
import { resolveDashboardRanges, type DashboardSearchParams } from "@/features/dashboard/dashboard-query";
import { requirePermission } from "@/server/auth/require-org";
import { db } from "@/server/db/client";
import { createOperationsDashboardMetricsService } from "@/server/services/operations-dashboard-metrics.service";

/** Tenant-scoped, timezone-safe Phase 1 dashboard. */
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const ctx = await requirePermission(Permission.DASHBOARD_READ);
  const ranges = resolveDashboardRanges(await searchParams, ctx.organization.timezone);
  const metrics = await createOperationsDashboardMetricsService({
    job: db.job,
    appointment: db.appointment,
    lead: db.lead,
  }).getMetrics({
    organizationId: ctx.organizationId,
    todayRange: ranges.todayRange,
    range: ranges.range,
  });

  return (
    <DashboardOverview
      organizationName={ctx.organization.name}
      currency={ctx.organization.currency}
      metrics={metrics}
    />
  );
}
