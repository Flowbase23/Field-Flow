import Link from "next/link";
import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { technicianDisplayName } from "@/server/repositories/technician.repo";
import { can } from "@/components/permission-gate";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { JobStatusControls } from "@/features/jobs/job-status-controls";
import { JobTechnicianAssignment } from "@/features/jobs/job-technician-assignment";
import { formatIntegerCents } from "@/features/jobs/job-money";
import { jobPriorityLabel, jobStatusActions, jobStatusLabel, jobTypeLabel } from "@/features/jobs/job-ui";
import { formatDateInTz } from "@/lib/dates";

/** Tenant-safe job detail, dispatch assignments, and linked scheduling feed. */
export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: { params: Promise<{ orgSlug: string; jobId: string }> }) {
  const { jobId } = await params;
  const ctx = await requirePermission(Permission.JOB_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const repos = tenantDb(ctx.organizationId);
  const job = await repos.jobs.getDetail(jobId);
  if (!job) notFound();
  const canUpdate = can(permissions, Permission.JOB_UPDATE);
  const canChangeStatus = can(permissions, Permission.JOB_STATUS_UPDATE);
  const canAssign = can(permissions, Permission.JOB_ASSIGN);
  const canReadSchedule = can(permissions, Permission.SCHEDULE_READ);
  const canCreateSchedule = can(permissions, Permission.SCHEDULE_CREATE);
  const [appointments, eligible] = await Promise.all([
    canReadSchedule ? repos.appointments.listForJob(job.id) : Promise.resolve([]),
    canAssign ? repos.jobs.listEligibleTechnicians() : Promise.resolve([]),
  ]);
  const customerName = (job.customer.companyName ?? [job.customer.firstName, job.customer.lastName].filter(Boolean).join(" ")) || "Customer";
  const timestamps = [["Created", job.createdAt], ["Last updated", job.updatedAt], ["Completed", job.completedAt], ["Cancelled", job.cancelledAt]] as const;

  return <div className="mx-auto max-w-5xl space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-sm text-muted-foreground"><Link href={`/${ctx.organization.slug}/jobs`} className="hover:underline">Jobs</Link> / #{job.jobNumber}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{job.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{jobStatusLabel(job.status)}</span><span>{jobTypeLabel(job.type)}</span><span>{jobPriorityLabel(job.priority)} priority</span></div>
      </div>
      {canUpdate && <Link href={`/${ctx.organization.slug}/jobs/${job.id}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>Edit job</Link>}
    </div>

    {canChangeStatus && <Card><CardHeader><CardTitle>Lifecycle</CardTitle><CardDescription>Move this job through its allowed work-order states. The server verifies every transition.</CardDescription></CardHeader><CardContent><JobStatusControls jobId={job.id} currentStatus={job.status} actions={jobStatusActions(job.status)} /></CardContent></Card>}

    <div className="grid gap-6 md:grid-cols-2">
      <Card><CardHeader><CardTitle>Customer & location</CardTitle></CardHeader><CardContent className="space-y-3 text-sm"><p><span className="text-muted-foreground">Customer</span><br /><Link href={`/${ctx.organization.slug}/customers/${job.customer.id}`} className="font-medium text-primary hover:underline">{customerName}</Link></p><p><span className="text-muted-foreground">Service location</span><br /><span className="font-medium">{job.location.label}</span><br />{job.location.address1}<br />{job.location.city}, {job.location.state} {job.location.postalCode}</p>{job.lead && <p><span className="text-muted-foreground">Linked lead</span><br /><Link href={`/${ctx.organization.slug}/leads/${job.lead.id}`} className="font-medium text-primary hover:underline">{job.lead.title}</Link></p>}</CardContent></Card>
      <Card><CardHeader><CardTitle>Amounts</CardTitle><CardDescription>Job-level amounts only; invoice and payment workflows are not part of this screen.</CardDescription></CardHeader><CardContent><dl className="space-y-2 text-sm"><Amount label="Quoted amount" value={job.quotedAmountCents} currency={ctx.organization.currency} /><Amount label="Subtotal" value={job.subtotalCents} currency={ctx.organization.currency} /><Amount label="Tax" value={job.taxCents} currency={ctx.organization.currency} /><Amount label="Total" value={job.totalCents} currency={ctx.organization.currency} strong /><Amount label="Actual revenue" value={job.actualRevenueCents} currency={ctx.organization.currency} /></dl></CardContent></Card>
    </div>

    <Card><CardHeader><CardTitle>Technician assignment</CardTitle><CardDescription>{canAssign ? "Dispatch controls are available for this role." : "Read-only. You do not have permission to change dispatch assignments."}</CardDescription></CardHeader><CardContent><JobTechnicianAssignment jobId={job.id} canAssign={canAssign} assigned={job.technicians.map((assignment) => ({ technicianId: assignment.technicianId, name: technicianDisplayName(assignment.technician), employeeCode: assignment.technician.employeeCode, isPrimary: assignment.isPrimary, isActive: assignment.technician.isActive }))} eligible={eligible.map((technician) => ({ id: technician.id, name: technicianDisplayName(technician), employeeCode: technician.employeeCode }))} /></CardContent></Card>

    <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><div><CardTitle>Appointments</CardTitle><CardDescription>Appointments linked to this job, shown in the organization timezone ({ctx.organization.timezone}).</CardDescription></div>{canCreateSchedule && <Link href={`/${ctx.organization.slug}/schedule?jobId=${job.id}`} className={buttonVariants({ size: "sm" })}>Schedule appointment</Link>}</div></CardHeader><CardContent>{canReadSchedule ? (appointments.length === 0 ? <p className="text-sm text-muted-foreground">No appointments are linked to this job.</p> : <ul className="space-y-2">{appointments.map((appointment) => <li key={appointment.id} className="rounded-lg border px-3 py-2 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{appointment.title}</span><span className="rounded-full bg-muted px-2 py-0.5 text-xs">{appointment.status.replaceAll("_", " ")}</span></div><p className="mt-1 text-muted-foreground">{formatDateInTz(appointment.startsAt, ctx.organization.timezone, "medium")} – {new Intl.DateTimeFormat("en-US", { timeZone: ctx.organization.timezone, hour: "numeric", minute: "2-digit" }).format(appointment.endsAt)}</p><p className="mt-1 text-muted-foreground">{appointment.technicians.length ? appointment.technicians.map((item) => technicianDisplayName(item.technician)).join(", ") : "No technicians assigned"}</p></li>)}</ul>) : <p className="text-sm text-muted-foreground">You need schedule access to view linked appointments.</p>}</CardContent></Card>

    {job.description && <Card><CardHeader><CardTitle>Description</CardTitle></CardHeader><CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">{job.description}</CardContent></Card>}
    <Card><CardHeader><CardTitle>Activity timestamps</CardTitle></CardHeader><CardContent><dl className="grid gap-3 text-sm sm:grid-cols-2">{timestamps.map(([label, date]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{date ? formatDateInTz(date, ctx.organization.timezone, "medium") : "—"}</dd></div>)}</dl></CardContent></Card>
  </div>;
}

function Amount({ label, value, currency, strong = false }: { label: string; value: number | null; currency: string; strong?: boolean }) { return <div className="flex items-center justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className={strong ? "font-semibold" : "font-medium"}>{value === null ? "—" : formatIntegerCents(value, currency)}</dd></div>; }
