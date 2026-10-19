import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { formatDateInTz, formatTimeInTz, utcToLocalDateTime } from "@/lib/dates";
import { customerLabel, formatMinutes } from "@/features/technician-portal/technician-portal-ui";
import { NotATechnician } from "@/features/technician-portal/not-technician";
import { TimeEntryForm } from "@/features/technician-portal/time-entry-form";

/**
 * Technician job detail (P2-S5): the field view for ONE job, reachable only
 * when the signed-in technician is ASSIGNED to it — getDetailForTechnician
 * returns null otherwise (→ 404, no existence leak across tenants or
 * unassigned jobs). Includes the job's own appointments (filtered to self) and
 * the technician's own time entries with the log-time form.
 */
export const dynamic = "force-dynamic";

export default async function MyJobDetailPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const ctx = await requirePermission(Permission.JOB_READ);
  const repos = tenantDb(ctx.organizationId);
  const self = await repos.technicians.getByUserId(ctx.userId);
  if (!self) return <NotATechnician title="My Jobs" />;
  const job = await repos.jobs.getDetailForTechnician(jobId, self.id);
  if (!job) notFound();
  const timezone = ctx.organization.timezone;
  const [appointments, entries] = await Promise.all([
    repos.appointments.listForJob(job.id),
    repos.timeEntries.listForJob(job.id, { technicianId: self.id }),
  ]);
  const myAppointments = appointments.filter((appointment) =>
    appointment.technicians.some((technician) => technician.technicianId === self.id),
  );
  const today = utcToLocalDateTime(new Date(), timezone).slice(0, 10);
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">#{job.jobNumber} · {job.title}</h1>
        <p className="mt-1 text-muted-foreground">
          {job.type.replace(/_/g, " ").toLowerCase()} · {job.status.replace(/_/g, " ").toLowerCase()} · {job.priority.toLowerCase()} priority
        </p>
      </div>
      <div className="rounded-xl border bg-card p-4 text-sm">
        <p><span className="text-muted-foreground">Customer:</span> {customerLabel(job.customer)}</p>
        {job.location && (
          <p className="mt-1"><span className="text-muted-foreground">Service location:</span> {[job.location.label, job.location.address1, job.location.city, job.location.state, job.location.postalCode].filter(Boolean).join(", ")}</p>
        )}
        {job.description && <p className="mt-1"><span className="text-muted-foreground">Notes:</span> {job.description}</p>}
      </div>
      <section>
        <h2 className="mb-2 font-semibold">Scheduled visits</h2>
        {myAppointments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No visits scheduled for you on this job.</p>
        ) : (
          <div className="space-y-2">
            {myAppointments.map((appointment) => (
              <div key={appointment.id} className="rounded-xl border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{appointment.title}</p>
                  <p className="text-muted-foreground">{formatDateInTz(appointment.startsAt, timezone)} · {formatTimeInTz(appointment.startsAt, timezone)} – {formatTimeInTz(appointment.endsAt, timezone)}</p>
                </div>
                <p className="mt-1 text-muted-foreground">{appointment.status} · {appointment.location?.label ?? "no location"}</p>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">My time on this job</h2>
        <TimeEntryForm jobs={[{ id: job.id, label: `#${job.jobNumber} ${job.title}` }]} today={today} />
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No time logged yet.</p>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between rounded-xl border bg-card p-3 text-sm">
                <p>{formatDateInTz(entry.startedAt, timezone)}{entry.billable ? " · billable" : ""}</p>
                <p className="text-muted-foreground">{formatMinutes(entry.minutes ?? 0)}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
