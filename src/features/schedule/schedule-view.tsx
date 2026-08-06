"use client";
/**
 * Schedule view (Phase 1, Slice 4) — day / week / month calendar.
 *
 * Renders tenant-scoped appointments (already filtered server-side by the
 * visible range + technician filter) in the ORGANIZATION timezone with a
 * lightweight custom grid (no heavy calendar dependency). Navigation and the
 * technician filter are URL state (searchParams) so the server re-queries the
 * exact visible range. Click-to-create opens the RHF/Zod dialog prefilled;
 * clicking an appointment opens the detail popover with status actions.
 *
 * Drag-and-drop rescheduling is intentionally deferred to a later enhancement.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { addDays, localDateTimeToUtc, nextDayInTz, startOfDayInTz, utcToLocalDateTime } from "@/lib/dates";
import { Button } from "@/components/ui/button";
import { AppointmentForm, type AppointmentFormInitial } from "./appointment-form";
import { AppointmentDetail } from "./appointment-detail";
import {
  appointmentDayPosition,
  DAY_MINUTES,
  dayOfMonth,
  formatDayInTz,
  isToday,
  statusDotClass,
  viewRange,
  viewTitle,
  type ScheduleView,
  type SerializedAppointment,
  type SerializedTechnician,
} from "./calendar";

const MINUTE_PX = 1.25; // 75px per hour
const HOURS = Array.from({ length: 24 }, (_, i) => i);

interface ScheduleViewClientProps {
  orgSlug: string;
  timezone: string;
  view: ScheduleView;
  anchorDate: string; // YYYY-MM-DD local
  appointments: SerializedAppointment[];
  technicians: SerializedTechnician[];
  selectedTechIds: string[];
  locations: { id: string; label: string }[];
  jobs: { id: string; title: string }[];
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export function ScheduleViewClient(props: ScheduleViewClientProps) {
  const { orgSlug, timezone, view, anchorDate, appointments, technicians, selectedTechIds, locations, jobs, canCreate, canUpdate, canDelete } = props;
  const [draft, setDraft] = useState<AppointmentFormInitial | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SerializedAppointment | null>(null);

  const anchor = useMemo(() => localDateTimeToUtc(`${anchorDate}T00:00`, timezone), [anchorDate, timezone]);
  const range = useMemo(() => viewRange(view, anchor, timezone), [view, anchor, timezone]);
  const todayLocal = useMemo(() => utcToLocalDateTime(new Date(), timezone).slice(0, 10), [timezone]);

  // ── URL helpers (state lives in the URL so the server re-queries the range) ──
  function hrefFor(nextView: ScheduleView, nextAnchor: Date): string {
    const date = utcToLocalDateTime(nextAnchor, timezone).slice(0, 10);
    const params = new URLSearchParams({ view: nextView, date });
    if (selectedTechIds.length > 0) params.set("tech", selectedTechIds.join(","));
    return `/${orgSlug}/schedule?${params.toString()}`;
  }
  function shiftDays(days: number): string {
    if (days > 0) {
      let d = anchor;
      for (let i = 0; i < days; i++) d = nextDayInTz(d, timezone);
      return hrefFor(view, d);
    }
    let d = anchor;
    for (let i = 0; i < -days; i++) d = startOfDayInTz(addDays(d, -1), timezone);
    return hrefFor(view, d);
  }
  function toggleTech(id: string): string {
    const next = selectedTechIds.includes(id) ? selectedTechIds.filter((t) => t !== id) : [...selectedTechIds, id];
    const params = new URLSearchParams({ view, date: anchorDate });
    if (next.length > 0) params.set("tech", next.join(","));
    return `/${orgSlug}/schedule?${params.toString()}`;
  }

  // Appointments visible per day (day/week: overlapping the day; month: same day).
  function appointmentsOn(dayStart: Date): SerializedAppointment[] {
    const startMs = dayStart.getTime();
    const endMs = nextDayInTz(dayStart, timezone).getTime();
    return appointments.filter((a) => {
      const s = new Date(a.startsAt).getTime();
      const e = new Date(a.endsAt).getTime();
      return s < endMs && e > startMs;
    });
  }

  function openCreate(dayStart: Date, hour?: number) {
    if (!canCreate) return;
    const start = hour !== undefined ? new Date(dayStart.getTime() + hour * 3_600_000) : new Date(dayStart.getTime() + 9 * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);
    setDraft({ id: undefined, title: "", type: "JOB", startsAt: start.toISOString(), endsAt: end.toISOString(), timezone, technicianIds: [], jobId: null, locationId: null, travelMinutesBefore: 0, travelMinutesAfter: 0, notes: null });
    setCreateOpen(true);
  }

  const initialForEdit = editTarget
    ? {
        id: editTarget.id,
        title: editTarget.title,
        type: editTarget.type,
        startsAt: editTarget.startsAt,
        endsAt: editTarget.endsAt,
        timezone: editTarget.timezone,
        technicianIds: editTarget.technicianIds,
        jobId: editTarget.jobId,
        locationId: editTarget.locationId,
        travelMinutesBefore: editTarget.travelMinutesBefore,
        travelMinutesAfter: editTarget.travelMinutesAfter,
        notes: editTarget.notes,
      }
    : null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
          {(["day", "week", "month"] as const).map((v) => (
            <Link key={v} href={hrefFor(v, anchor)} className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize ${view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
              {v}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" render={<Link href={shiftDays(view === "month" ? -31 : view === "week" ? -7 : -1)} />}>‹ Prev</Button>
          <Button variant="outline" size="sm" render={<Link href={hrefFor(view, localDateTimeToUtc(`${todayLocal}T00:00`, timezone))} />}>Today</Button>
          <Button variant="outline" size="sm" render={<Link href={shiftDays(view === "month" ? 31 : view === "week" ? 7 : 1)} />}>Next ›</Button>
        </div>
        <h2 className="order-first w-full text-lg font-semibold tracking-tight sm:order-none sm:w-auto">{viewTitle(view, anchor, timezone)}</h2>
      </div>

      {/* Technician filter */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Technicians:</span>
        {technicians.map((t) => {
          const active = selectedTechIds.includes(t.id);
          return (
            <Link key={t.id} href={toggleTech(t.id)} className={`rounded-full border px-2.5 py-0.5 text-xs ${active ? "border-primary bg-primary/10 font-medium text-primary" : "border-input text-muted-foreground hover:bg-muted"}`}>
              {t.name}
            </Link>
          );
        })}
        {selectedTechIds.length > 0 && (
          <Link href={`/${orgSlug}/schedule?view=${view}&date=${anchorDate}`} className="text-xs text-muted-foreground underline">
            Clear
          </Link>
        )}
        {technicians.length === 0 && <span className="text-xs text-muted-foreground">No active technicians.</span>}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {["TENTATIVE", "CONFIRMED", "EN_ROUTE", "IN_PROGRESS", "COMPLETED", "MISSED", "CANCELLED"].map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${statusDotClass(s)}`} />
            {s.charAt(0) + s.slice(1).toLowerCase().replaceAll("_", " ")}
          </span>
        ))}
      </div>

      {/* Grids */}
      {view === "day" && (
        <DayGrid
          dayStart={range.days[0]}
          appointments={appointmentsOn(range.days[0])}
          timezone={timezone}
          canCreate={canCreate}
          canUpdate={canUpdate}
          canDelete={canDelete}
          onCreate={openCreate}
          onEdit={setEditTarget}
        />
      )}
      {view === "week" && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-7">
          {range.days.map((day) => (
            <div key={day.toISOString()} className="min-w-0">
              <div className={`mb-1 rounded-md px-2 py-1 text-center text-xs font-medium ${isToday(day, timezone) ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}>
                {formatDayInTz(day, timezone)}
              </div>
              <DayGrid
                dayStart={day}
                appointments={appointmentsOn(day)}
                timezone={timezone}
                canCreate={canCreate}
                canUpdate={canUpdate}
                canDelete={canDelete}
                onCreate={openCreate}
                onEdit={setEditTarget}
              />
            </div>
          ))}
        </div>
      )}
      {view === "month" && (
        <MonthGrid
          anchor={anchor}
          timezone={timezone}
          appointments={appointments}
          canCreate={canCreate}
          canUpdate={canUpdate}
          canDelete={canDelete}
          onCreate={openCreate}
          onEdit={setEditTarget}
        />
      )}

      {appointments.length === 0 && <p className="text-sm text-muted-foreground">No appointments in this view{selectedTechIds.length > 0 ? " for the selected technicians" : ""}. {canCreate ? "Click a time slot to create one." : ""}</p>}

      {/* Create dialog */}
      {createOpen && draft && (
        <AppointmentForm
          orgSlug={orgSlug}
          initial={draft}
          technicians={technicians}
          locations={locations}
          jobs={jobs}
          showAllowOverlap={canUpdate}
        />
      )}
      {/* Edit dialog */}
      {editTarget && initialForEdit && (
        <AppointmentForm
          orgSlug={orgSlug}
          initial={initialForEdit}
          technicians={technicians}
          locations={locations}
          jobs={jobs}
          showAllowOverlap={canUpdate}
        />
      )}
    </div>
  );
}

/** A single day column: 24h time grid + positioned appointment blocks. */
function DayGrid({
  dayStart,
  appointments,
  timezone,
  canCreate,
  canUpdate,
  canDelete,
  onCreate,
  onEdit,
}: {
  dayStart: Date;
  appointments: SerializedAppointment[];
  timezone: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onCreate: (dayStart: Date, hour?: number) => void;
  onEdit: (a: SerializedAppointment) => void;
}) {
  const today = isToday(dayStart, timezone);
  return (
    <div className="relative overflow-hidden rounded-lg border bg-background">
      {/* Hour rows (click target for quick create) */}
      <div className="absolute inset-0">
        {HOURS.map((h) => (
          <button
            key={h}
            type="button"
            disabled={!canCreate}
            onClick={() => onCreate(dayStart, h)}
            aria-label={`Create appointment at ${h}:00`}
            className={`block w-full border-b border-muted/60 text-right align-top last:border-b-0 ${canCreate ? "cursor-pointer hover:bg-muted/40" : "cursor-default"}`}
            style={{ height: 60 * MINUTE_PX }}
          >
            <span className="pr-1 text-[10px] leading-none text-muted-foreground">{h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}</span>
          </button>
        ))}
      </div>
      {/* Now marker */}
      {today && (
        <NowMarker dayStart={dayStart} timezone={timezone} />
      )}
      {/* Appointment blocks */}
      {appointments.map((a) => {
        const pos = appointmentDayPosition(a, dayStart, timezone);
        if (pos.height <= 0) return null;
        return (
          <div
            key={a.id}
            className="absolute left-2 right-2 overflow-hidden"
            style={{ top: pos.top * MINUTE_PX, height: Math.max(22, pos.height * MINUTE_PX - 2) }}
          >
            <AppointmentDetail appointment={a} timezone={timezone} canUpdate={canUpdate} canDelete={canDelete} onEdit={onEdit} />
          </div>
        );
      })}
    </div>
  );
}

/** Red line at the current local time. */
function NowMarker({ dayStart, timezone }: { dayStart: Date; timezone: string }) {
  const now = new Date();
  const minutes = (now.getTime() - dayStart.getTime()) / 60_000;
  if (minutes < 0 || minutes > DAY_MINUTES) return null;
  return (
    <div className="pointer-events-none absolute left-0 right-0 z-10 border-t-2 border-rose-500" style={{ top: minutes * MINUTE_PX }}>
      <span className="absolute -left-0.5 -top-1.5 h-3 w-3 rounded-full bg-rose-500" />
    </div>
  );
}

function MonthGrid({
  anchor,
  timezone,
  appointments,
  canCreate,
  canUpdate,
  canDelete,
  onCreate,
  onEdit,
}: {
  anchor: Date;
  timezone: string;
  appointments: SerializedAppointment[];
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onCreate: (dayStart: Date, hour?: number) => void;
  onEdit: (a: SerializedAppointment) => void;
}) {
  const weeks = useMemo(() => viewRange("month", anchor, timezone).days, [anchor, timezone]);
  const grid = useMemo(() => {
    const rows: Date[][] = [];
    for (let i = 0; i < weeks.length; i += 7) rows.push(weeks.slice(i, i + 7));
    return rows;
  }, [weeks]);
  const todayLocal = useMemo(() => utcToLocalDateTime(new Date(), timezone).slice(0, 10), [timezone]);
  const anchorMonth = utcToLocalDateTime(anchor, timezone).slice(0, 7);

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="grid grid-cols-7 border-b text-center text-xs font-medium text-muted-foreground">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="py-1.5">{d}</div>
        ))}
      </div>
      {grid.map((week, wi) => (
        <div key={wi} className="grid grid-cols-7">
          {week.map((day) => {
            const inMonth = utcToLocalDateTime(day, timezone).slice(0, 7) === anchorMonth;
            const today = utcToLocalDateTime(day, timezone).slice(0, 10) === todayLocal;
            const dayApps = appointments.filter((a) => {
              const s = new Date(a.startsAt).getTime();
              const e = new Date(a.endsAt).getTime();
              const start = day.getTime();
              const end = nextDayInTz(day, timezone).getTime();
              return s < end && e > start;
            });
            return (
              <div
                key={day.toISOString()}
                onClick={() => canCreate && onCreate(day, 9)}
                className={`min-h-24 cursor-pointer border-b border-r border-muted/60 p-1 align-top last:border-r-0 hover:bg-muted/40 ${inMonth ? "" : "bg-muted/30"} ${today ? "ring-1 ring-inset ring-primary/50" : ""}`}
              >
                <div className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${today ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground"}`}>
                  {dayOfMonth(day, timezone)}
                </div>
                <div className="mt-0.5 space-y-0.5">
                  {dayApps.slice(0, 3).map((a) => (
                    <div key={a.id} onClick={(e) => e.stopPropagation()}>
                      <AppointmentDetail appointment={a} timezone={timezone} canUpdate={canUpdate} canDelete={canDelete} onEdit={onEdit} />
                    </div>
                  ))}
                  {dayApps.length > 3 && <p className="px-1 text-[10px] text-muted-foreground">+{dayApps.length - 3} more</p>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Export for the server page.
export type { ScheduleView };
