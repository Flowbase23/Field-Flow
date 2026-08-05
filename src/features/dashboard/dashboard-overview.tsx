import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Dashboard placeholder (Phase 1 Slice 6 delivers the real KPIs).
 *
 * The 8 metrics are specified in design §4 with explicit definitions:
 * today's jobs, in-progress, completed, revenue (metric definition pending
 * owner decision), outstanding invoices, avg ticket, utilization, lead
 * conversion, missed appointments. All are org-scoped aggregate queries over
 * the indexed columns in the Phase 1 schema — no warehouse.
 */
const KPI_DEFINITIONS = [
  { key: "today", label: "Today's jobs", definition: "Appointments in the org-local day (design §4.1)" },
  { key: "inProgress", label: "In progress", definition: "Jobs with status IN_PROGRESS" },
  { key: "completed", label: "Completed", definition: "Jobs by completedAt" },
  { key: "revenue", label: "Revenue", definition: "Metric definition pending owner decision (§4.4)" },
  { key: "outstanding", label: "Outstanding invoices", definition: "balanceCents > 0, SENT/PARTIALLY_PAID/OVERDUE" },
  { key: "avgTicket", label: "Avg ticket", definition: "sum(actualRevenueCents)/completed jobs" },
  { key: "utilization", label: "Utilization", definition: "Planned (appointments) vs actual (TimeEntry)" },
  { key: "leadConversion", label: "Lead conversion", definition: "won/total — cohort definition pending (§4.7)" },
];

export function DashboardOverview({ organizationName }: { organizationName: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{organizationName}</h1>
        <p className="text-sm text-muted-foreground">
          Dashboard — KPI cards land in Phase 1 Slice 6.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {KPI_DEFINITIONS.map((kpi) => (
          <Card key={kpi.key}>
            <CardHeader>
              <CardTitle className="text-sm">{kpi.label}</CardTitle>
              <CardDescription className="text-xs">{kpi.definition}</CardDescription>
            </CardHeader>
            <CardContent className="text-2xl font-semibold text-muted-foreground">—</CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
