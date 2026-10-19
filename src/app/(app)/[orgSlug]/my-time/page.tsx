import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { formatDateInTz, formatTimeInTz, utcToLocalDateTime } from "@/lib/dates";
import { formatMinutes } from "@/features/technician-portal/technician-portal-ui";
import { NotATechnician } from "@/features/technician-portal/not-technician";
import { TimeEntryForm } from "@/features/technician-portal/time-entry-form";

/**
 * Technician time-entry view (P2-S5): the signed-in technician's own entries
 * (newest first) + the log-time form. Entries are scoped to technicianId =
 * self (resolved server-side); TIME_CREATE (technician, owner/admin) logs,
 * TIME_READ (also office staff) reads.
 */
export const dynamic = "force-dynamic";

export default async function MyTimePage() {
  const ctx = await requirePermission(Permission.TIME_READ);
  const repos = tenantDb(ctx.organizationId);
  const self = await repos.technicians.getByUserId(ctx.userId);
  if (!self) return <NotATechnician title="My Time" />;
  const timezone = ctx.organization.timezone;
  const [entries, jobs] = await Promise.all([
    repos.timeEntries.listForTechnician(self.id),
    repos.jobs.listForTechnician(self.id),
  ]);
  const today = utcToLocalDateTime(new Date(), timezone).slice(0, 10);
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My Time</h1>
        <p className="mt-1 text-muted-foreground">{ctx.organization.name} · your logged time</p>
      </div>
      <TimeEntryForm jobs={jobs.map((job) => ({ id: job.id, label: `#${job.jobNumber} ${job.title}` }))} today={today} />
      {entries.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No time logged yet.</div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-3 text-sm">
              <p className="font-medium">{formatDateInTz(entry.startedAt, timezone)}{entry.job ? ` · #${entry.job.jobNumber} ${entry.job.title}` : " · General time"}</p>
              <p className="text-muted-foreground">
                {entry.endedAt ? `${formatTimeInTz(entry.startedAt, timezone)} – ${formatTimeInTz(entry.endedAt, timezone)} · ` : ""}
                {formatMinutes(entry.minutes ?? 0)}
                {entry.billable ? " · billable" : ""}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
