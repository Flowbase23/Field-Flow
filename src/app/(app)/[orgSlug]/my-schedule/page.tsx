import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { addDays, formatTimeInTz, startOfDayInTz } from "@/lib/dates";
import { groupAppointmentsByDay } from "@/features/technician-portal/technician-portal-ui";
import { NotATechnician } from "@/features/technician-portal/not-technician";

/**
 * Technician schedule view (P2-S5): ONLY the signed-in technician's own
 * appointments for the next 7 org-days. Scoping is enforced here (technicianId
 * = self, resolved server-side from the session user) and in the appointment
 * repo's technicianIds filter — a technician never sees another technician's
 * row. The org-wide /schedule stays for office/admin/dispatcher roles
 * (technicians are redirected there-to-my-schedule).
 */
export const dynamic = "force-dynamic";

export default async function MySchedulePage() {
  const ctx = await requirePermission(Permission.SCHEDULE_READ);
  const repos = tenantDb(ctx.organizationId);
  const self = await repos.technicians.getByUserId(ctx.userId);
  if (!self) return <NotATechnician title="My Schedule" />;
  const timezone = ctx.organization.timezone;
  const start = startOfDayInTz(new Date(), timezone);
  const end = startOfDayInTz(addDays(new Date(), 7), timezone);
  const appointments = await repos.appointments.listInRange({ start, end, technicianIds: [self.id] });
  const groups = groupAppointmentsByDay(
    appointments.map((appointment) => ({
      id: appointment.id,
      title: appointment.title,
      status: appointment.status,
      startsAt: appointment.startsAt.toISOString(),
      endsAt: appointment.endsAt.toISOString(),
      jobTitle: appointment.job?.title ?? null,
      locationLabel: appointment.location?.label ?? null,
    })),
    timezone,
  );
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4">
        <h1 className="text-3xl font-bold tracking-tight">My Schedule</h1>
        <p className="mt-1 text-muted-foreground">{ctx.organization.name} · {timezone} · next 7 days</p>
      </div>
      {groups.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-muted-foreground">No appointments coming up.</div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.dateKey} aria-label={group.label}>
              <h2 className={`text-sm font-semibold ${group.isToday ? "text-primary" : "text-muted-foreground"}`}>{group.label}</h2>
              <div className="mt-2 space-y-2">
                {group.items.map((item) => (
                  <div key={item.id} className="rounded-xl border bg-card p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium">{item.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatTimeInTz(new Date(item.startsAt), timezone)} – {formatTimeInTz(new Date(item.endsAt), timezone)}
                      </p>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {[item.jobTitle, item.locationLabel].filter(Boolean).join(" · ") || "No job linked"}
                      <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">{item.status}</span>
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
