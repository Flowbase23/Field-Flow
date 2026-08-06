/**
 * features/schedule/calendar — client-safe pure helpers for the calendar views
 * (Phase 1, Slice 4).
 *
 * No server imports, no @prisma/client runtime import (status/type are plain
 * strings in the serialized appointment shape). The grid math itself lives in
 * lib/dates.ts (DST-tested); this module only maps appointments/statuses/types
 * to view geometry and labels.
 */
import {
  addDays,
  datePartsInTz,
  endOfDayInTz,
  formatDayInTz,
  monthGridInTz,
  nextDayInTz,
  startOfDayInTz,
  startOfWeekInTz,
} from "@/lib/dates";

export type ScheduleView = "day" | "week" | "month";

/** Plain serialized appointment passed from the server page to the client. */
export interface SerializedAppointment {
  id: string;
  title: string;
  type: string;
  status: string;
  startsAt: string; // UTC ISO
  endsAt: string; // UTC ISO
  timezone: string;
  travelMinutesBefore: number;
  travelMinutesAfter: number;
  notes: string | null;
  jobId: string | null;
  locationId: string | null;
  jobTitle: string | null;
  locationLabel: string | null;
  technicianIds: string[];
  technicianNames: string[];
}

export interface SerializedTechnician {
  id: string;
  name: string;
}

// ─── Labels ──────────────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<string, string> = {
  TENTATIVE: "Tentative",
  CONFIRMED: "Confirmed",
  EN_ROUTE: "En route",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  MISSED: "Missed",
  CANCELLED: "Cancelled",
};

export const TYPE_LABELS: Record<string, string> = {
  JOB: "Job",
  BLOCKED_TIME: "Blocked time",
  TRAVEL: "Travel",
  OTHER: "Other",
};

/** Tailwind classes for an appointment chip by status. */
export function statusChipClass(status: string): string {
  switch (status) {
    case "CONFIRMED":
      return "border-blue-300 bg-blue-50 text-blue-900";
    case "EN_ROUTE":
      return "border-amber-300 bg-amber-50 text-amber-900";
    case "IN_PROGRESS":
      return "border-violet-300 bg-violet-50 text-violet-900";
    case "COMPLETED":
      return "border-emerald-300 bg-emerald-50 text-emerald-900";
    case "MISSED":
      return "border-rose-300 bg-rose-50 text-rose-900";
    case "CANCELLED":
      return "border-muted bg-muted text-muted-foreground line-through";
    default: // TENTATIVE
      return "border-slate-300 bg-slate-50 text-slate-800";
  }
}

/** Small colored dot for legend/detail. */
export function statusDotClass(status: string): string {
  switch (status) {
    case "CONFIRMED": return "bg-blue-500";
    case "EN_ROUTE": return "bg-amber-500";
    case "IN_PROGRESS": return "bg-violet-500";
    case "COMPLETED": return "bg-emerald-500";
    case "MISSED": return "bg-rose-500";
    case "CANCELLED": return "bg-muted-foreground";
    default: return "bg-slate-400";
  }
}

export function typeChipClass(type: string): string {
  switch (type) {
    case "JOB": return "bg-primary/10 text-primary";
    case "BLOCKED_TIME": return "bg-muted text-muted-foreground";
    case "TRAVEL": return "bg-sky-100 text-sky-800";
    default: return "bg-secondary text-secondary-foreground";
  }
}

// ─── View geometry ───────────────────────────────────────────────────────────

export const DAY_MINUTES = 24 * 60;

export interface ViewRange {
  /** UTC instant of the first visible local midnight. */
  start: Date;
  /** Exclusive end of the view window (UTC). */
  end: Date;
  /** One entry per visible day: UTC instant of local midnight. */
  days: Date[];
}

/**
 * The calendar window for a view anchored at `anchor` (a local midnight UTC
 * instant) in `timeZone`. Day = 1 day; week = Mon-first 7 local days; month =
 * the full grid (leading/trailing days included so rows are complete).
 */
export function viewRange(view: ScheduleView, anchor: Date, timeZone: string): ViewRange {
  if (view === "day") {
    return { start: anchor, end: nextDayInTz(anchor, timeZone), days: [anchor] };
  }
  if (view === "week") {
    const start = startOfWeekInTz(anchor, timeZone, 1);
    const days: Date[] = [start];
    let cursor = start;
    for (let i = 1; i < 7; i++) {
      cursor = nextDayInTz(cursor, timeZone);
      days.push(cursor);
    }
    return { start, end: nextDayInTz(days[6], timeZone), days };
  }
  const weeks = monthGridInTz(anchor, timeZone);
  const days = weeks.flat();
  return { start: days[0], end: nextDayInTz(days[days.length - 1], timeZone), days };
}

/** Title for the toolbar, e.g. "Wed, Aug 5, 2026" / "Aug 3 – 9, 2026" / "August 2026". */
export function viewTitle(view: ScheduleView, anchor: Date, timeZone: string): string {
  if (view === "day") {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(anchor);
  }
  if (view === "week") {
    const weekStart = startOfWeekInTz(anchor, timeZone, 1);
    const weekEnd = addDays(weekStart, 6);
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" });
    const fmtYear = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" });
    const a = datePartsInTz(weekStart, timeZone);
    const b = datePartsInTz(weekEnd, timeZone);
    return `${fmt.format(weekStart)} – ${fmt.format(weekEnd)}, ${fmtYear.format(a.year === b.year ? weekStart : weekEnd)}`;
  }
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "long", year: "numeric" }).format(anchor);
}

/** Clamped position of an appointment within one local day, in minutes. */
export function appointmentDayPosition(
  appt: Pick<SerializedAppointment, "startsAt" | "endsAt">,
  dayStart: Date,
  timeZone: string,
): { top: number; height: number } {
  const start = Math.max(new Date(appt.startsAt).getTime(), dayStart.getTime());
  const dayEnd = endOfDayInTz(dayStart, timeZone).getTime() + 1;
  const end = Math.min(new Date(appt.endsAt).getTime(), dayEnd);
  const topMs = start - dayStart.getTime();
  const heightMs = Math.max(0, end - start);
  const minutesPerMs = 1 / 60_000;
  return {
    top: Math.max(0, topMs * minutesPerMs),
    height: Math.max(0, heightMs * minutesPerMs),
  };
}

/** Short time label for chips, e.g. "9:30 AM". */
export function chipTimeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** Day-of-month label for month cells, e.g. "5". */
export function dayOfMonth(dayStart: Date, timeZone: string): number {
  return datePartsInTz(dayStart, timeZone).day;
}

export function isToday(dayStart: Date, timeZone: string, now: Date = new Date()): boolean {
  const a = datePartsInTz(dayStart, timeZone);
  const b = datePartsInTz(now, timeZone);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export { formatDayInTz, startOfDayInTz };
