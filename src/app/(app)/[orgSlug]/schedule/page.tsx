import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { can } from "@/components/permission-gate";
import { localDateTimeToUtc, utcToLocalDateTime } from "@/lib/dates";
import { technicianDisplayName } from "@/server/repositories/technician.repo";
import { viewRange, type ScheduleView } from "@/features/schedule/calendar";
import { ScheduleViewClient } from "@/features/schedule/schedule-view";

/**
 * Schedule page (Phase 1, Slice 4) — day/week/month calendar.
 *
 * The visible range is derived from URL state (view + local date + technician
 * filter) and queried tenant-scoped in the ORGANIZATION timezone: the anchor
 * date is interpreted as wall-clock in org tz, converted to UTC, and the range
 * window is [first visible local midnight, day after the last). Appointments
 * are serialized for the client, which renders the custom grid.
 *
 * Gated by SCHEDULE_READ; the client additionally receives canCreate /
 * canUpdate / canDelete so the UI only offers permitted actions (server
 * actions re-check independently).
 *
 * PENDING LIVE VERIFICATION: needs a real Clerk session.
 */
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; tech?: string }>;
}) {
  const ctx = await requirePermission(Permission.SCHEDULE_READ);
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
  const [appointments, technicians, locations] = await Promise.all([
    repos.appointments.listInRange({
      start: range.start,
      end: range.end,
      technicianIds: techFilter.length > 0 ? techFilter : undefined,
    }),
    repos.technicians.listActive(),
    repos.locations.listAll(),
  ]);

  const serialized = appointments.map((a) => ({
    id: a.id,
    title: a.title,
    type: a.type,
    status: a.status,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    timezone: a.timezone,
    travelMinutesBefore: a.travelMinutesBefore,
    travelMinutesAfter: a.travelMinutesAfter,
    notes: a.notes,
    jobId: a.jobId,
    locationId: a.locationId,
    jobTitle: a.job?.title ?? null,
    locationLabel: a.location?.label ?? null,
    technicianIds: a.technicians.map((t) => t.technicianId),
    technicianNames: a.technicians.map((t) => technicianDisplayName(t.technician)),
  }));
  const techOptions = technicians.map((t) => ({ id: t.id, name: technicianDisplayName(t) }));

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Schedule</h1>
          <p className="mt-1 text-muted-foreground">
            {ctx.organization.name} · {timezone}
          </p>
        </div>
      </div>
      <ScheduleViewClient
        orgSlug={ctx.organization.slug}
        timezone={timezone}
        view={view}
        anchorDate={dateParam}
        appointments={serialized}
        technicians={techOptions}
        selectedTechIds={techFilter}
        locations={locations.map((l) => ({ id: l.id, label: l.label }))}
        jobs={[]}
        canCreate={can(permissions, Permission.SCHEDULE_CREATE)}
        canUpdate={can(permissions, Permission.SCHEDULE_UPDATE)}
        canDelete={can(permissions, Permission.SCHEDULE_DELETE)}
      />
    </div>
  );
}
