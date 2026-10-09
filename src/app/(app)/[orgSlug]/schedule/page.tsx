import { Permission } from "@prisma/client";
import { redirect } from "next/navigation";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { can } from "@/components/permission-gate";
import { localDateTimeToUtc, utcToLocalDateTime } from "@/lib/dates";
import { technicianDisplayName } from "@/server/repositories/technician.repo";
import { viewRange, type ScheduleView } from "@/features/schedule/calendar";
import { ScheduleViewClient } from "@/features/schedule/schedule-view";

/** Tenant-scoped schedule; optional jobId is validated before opening the shared form. */
export const dynamic = "force-dynamic";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ view?: string; date?: string; tech?: string; jobId?: string }> }) {
  const ctx = await requirePermission(Permission.SCHEDULE_READ);
  // P2-S5: technicians get their OWN schedule (my-schedule) — the org-wide
  // calendar would expose other technicians' appointments.
  if (ctx.membership.role === "TECHNICIAN") {
    redirect(`/${ctx.organization.slug}/my-schedule`);
  }
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const sp = await searchParams;
  const timezone = ctx.organization.timezone;
  const view: ScheduleView = sp.view === "week" || sp.view === "month" ? sp.view : "day";
  const todayLocal = utcToLocalDateTime(new Date(), timezone).slice(0, 10);
  const dateParam = sp.date && DATE_RE.test(sp.date) ? sp.date : todayLocal;
  const anchor = localDateTimeToUtc(`${dateParam}T00:00`, timezone);
  const techFilter = (sp.tech ?? "").split(",").filter(Boolean);
  const range = viewRange(view, anchor, timezone);
  const repos = tenantDb(ctx.organizationId);
  const [appointments, technicians, locations, jobs, launchJob] = await Promise.all([
    repos.appointments.listInRange({ start: range.start, end: range.end, technicianIds: techFilter.length > 0 ? techFilter : undefined }),
    repos.technicians.listActive(), repos.locations.listAll(), repos.jobs.list({ pageSize: 100 }),
    sp.jobId && can(permissions, Permission.SCHEDULE_CREATE) ? repos.jobs.getDetail(sp.jobId) : Promise.resolve(null),
  ]);
  const serialized = appointments.map((appointment) => ({
    id: appointment.id, title: appointment.title, type: appointment.type, status: appointment.status,
    startsAt: appointment.startsAt.toISOString(), endsAt: appointment.endsAt.toISOString(), timezone: appointment.timezone,
    travelMinutesBefore: appointment.travelMinutesBefore, travelMinutesAfter: appointment.travelMinutesAfter, notes: appointment.notes,
    jobId: appointment.jobId, locationId: appointment.locationId, jobTitle: appointment.job?.title ?? null, locationLabel: appointment.location?.label ?? null,
    technicianIds: appointment.technicians.map((item) => item.technicianId), technicianNames: appointment.technicians.map((item) => technicianDisplayName(item.technician)),
  }));
  const initialCreate = launchJob ? {
    title: launchJob.title, type: "JOB", startsAt: new Date(anchor.getTime() + 9 * 3_600_000).toISOString(), endsAt: new Date(anchor.getTime() + 10 * 3_600_000).toISOString(),
    timezone, technicianIds: [], jobId: launchJob.id, locationId: launchJob.locationId, travelMinutesBefore: 0, travelMinutesAfter: 0, notes: null,
  } : null;
  return <div className="mx-auto max-w-7xl"><div className="mb-4 flex items-end justify-between"><div><h1 className="text-3xl font-bold tracking-tight">Schedule</h1><p className="mt-1 text-muted-foreground">{ctx.organization.name} · {timezone}</p></div></div><ScheduleViewClient orgSlug={ctx.organization.slug} timezone={timezone} view={view} anchorDate={dateParam} appointments={serialized} technicians={technicians.map((technician) => ({ id: technician.id, name: technicianDisplayName(technician) }))} selectedTechIds={techFilter} locations={locations.map((location) => ({ id: location.id, label: location.label }))} jobs={jobs.map((job) => ({ id: job.id, title: job.title, locationId: job.locationId }))} initialCreate={initialCreate} canCreate={can(permissions, Permission.SCHEDULE_CREATE)} canUpdate={can(permissions, Permission.SCHEDULE_UPDATE)} canDelete={can(permissions, Permission.SCHEDULE_DELETE)} /></div>;
}
