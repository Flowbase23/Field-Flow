import { Permission } from "@prisma/client";
import { redirect } from "next/navigation";
import { DashboardOverview } from "@/features/dashboard/dashboard-overview";
import { resolveDashboardRanges, type DashboardSearchParams } from "@/features/dashboard/dashboard-query";
import { requireOrg } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { db } from "@/server/db/client";
import { createOperationsDashboardMetricsService } from "@/server/services/operations-dashboard-metrics.service";

/** Tenant-scoped, timezone-safe Phase 1 dashboard. */
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  // P2-S5: roles without DASHBOARD_READ (technicians, portal users) land on
  // the scoped technician portal instead of the org-wide dashboard. The
  // permission check IS the gate — requirePermission would throw for the same
  // condition; we redirect instead of erroring.
  const base = await requireOrg();
  if (!(await permissionsFor(base.organizationId, base.membership.role)).includes(Permission.DASHBOARD_READ)) {
    redirect(`/${base.organization.slug}/my-schedule`);
  }
  const ctx = base;
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
