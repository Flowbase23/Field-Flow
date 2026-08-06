import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const KPI_DEFINITIONS = [
  ["today", "Today's jobs", "Appointments in the organization-local calendar day."],
  ["inProgress", "In progress", "Jobs currently in IN_PROGRESS status."],
  ["completed", "Completed", "Jobs completed during the selected period."],
  ["revenueToday", "Revenue today", "Paid invoice revenue recorded today (configurable; owner decision pending)."],
  ["revenueMonth", "Revenue this month", "Paid invoice revenue recorded this month (configurable; owner decision pending)."],
  ["outstanding", "Outstanding invoices", "Invoice balance greater than zero in SENT, PARTIALLY_PAID, or OVERDUE."],
  ["avgTicket", "Avg ticket", "Actual revenue divided by completed jobs."],
  ["utilization", "Tech utilization", "Planned appointment time compared with actual TimeEntry time."],
  ["leadConversion", "Lead conversion", "Won leads divided by total leads in the reporting cohort."],
  ["missed", "Missed appointments", "Appointments with MISSED status in the selected period."],
] as const;

export function DashboardOverview({ organizationName }: { organizationName: string }) {
  return <div className="space-y-8"><div><p className="text-sm font-medium text-primary">Overview</p><h1 className="text-3xl font-bold tracking-tight">{organizationName}</h1><p className="mt-1 text-muted-foreground">A clear view of your team’s work. Metrics will populate as activity is recorded.</p></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{KPI_DEFINITIONS.map(([key, label, definition]) => <Card key={key} className="min-h-36"><CardHeader className="pb-2"><CardTitle className="text-sm">{label}</CardTitle><CardDescription className="text-xs leading-relaxed">{definition}</CardDescription></CardHeader><CardContent><span className="text-2xl font-semibold text-muted-foreground">—</span><p className="mt-1 text-xs text-muted-foreground">No data yet</p></CardContent></Card>)}</div></div>;
}
