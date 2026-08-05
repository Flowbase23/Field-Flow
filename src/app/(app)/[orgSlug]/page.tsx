import { requirePermission } from "@/server/auth/require-org";
import { Permission } from "@prisma/client";
import { DashboardOverview } from "@/features/dashboard/dashboard-overview";

/**
 * Dashboard placeholder — the 8 KPI cards are specified in design §4 and
 * implemented in Slice 6 (KPI dashboard + hardening gate). This page only
 * establishes the route + authorization gate.
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const ctx = await requirePermission(Permission.DASHBOARD_READ);
  return <DashboardOverview organizationName={ctx.organization.name} />;
}
