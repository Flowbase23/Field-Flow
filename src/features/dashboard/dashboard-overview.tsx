import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import type { OperationsDashboardMetrics } from "@/server/services/operations-dashboard-metrics.service";

/**
 * Phase 1 KPI definitions. Every card below is backed by the operations metrics
 * service; invoice, payment, and TimeEntry-based metrics intentionally remain in
 * Phase 2 and are not shown as placeholders.
 */
export const KPI_DEFINITIONS = [
  ["scheduledToday", "Today's jobs", "JOB appointments not cancelled that overlap the organization-local calendar day."],
  ["inProgress", "In progress", "Jobs currently in IN_PROGRESS status, regardless of the reporting period."],
  ["completedInRange", "Completed", "Jobs with completedAt in the selected reporting period."],
  ["completedJobRevenue", "completed-job revenue", "Working assumption pending owner confirmation: actualRevenueCents summed for jobs completed in the selected period."],
  ["avgTicket", "Avg ticket", "completed-job revenue divided by completed jobs in the selected period; zero when there are none."],
  ["leadConversion", "Lead conversion", "WON leads with wonAt in the selected period divided by leads created in that period; zero when none were created."],
  ["missedInRange", "Missed appointments", "Appointments with MISSED status and startsAt in the selected reporting period."],
] as const satisfies readonly [keyof OperationsDashboardMetrics, string, string][];

export interface DashboardOverviewProps {
  organizationName: string;
  currency: string;
  metrics: OperationsDashboardMetrics;
}

export function DashboardOverview({ organizationName, currency, metrics }: DashboardOverviewProps) {
  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm font-medium text-primary">Overview</p>
        <h1 className="text-3xl font-bold tracking-tight">{organizationName}</h1>
        <p className="mt-1 text-muted-foreground">A clear view of your team’s work and selected-period performance.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {KPI_DEFINITIONS.map(([key, label, definition]) => (
          <Card key={key} className="min-h-36">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{label}</CardTitle>
              <CardDescription className="text-xs leading-relaxed">{definition}</CardDescription>
            </CardHeader>
            <CardContent>
              <span className="text-2xl font-semibold">{formatMetricValue(key, metrics[key], currency)}</span>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function formatMetricValue(
  key: keyof OperationsDashboardMetrics,
  value: number,
  currency: string,
): string {
  if (key === "completedJobRevenue" || key === "avgTicket") {
    return formatMoney(value, currency);
  }

  if (key === "leadConversion") {
    return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(value);
  }

  return String(value);
}
