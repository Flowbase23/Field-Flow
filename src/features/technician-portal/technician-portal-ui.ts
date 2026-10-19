/**
 * Pure helpers for the technician portal (Phase 2 Slice P2-S5). No database, no
 * server-only imports beyond the timezone helpers — everything here is
 * unit-testable and safe to import from client components.
 */
import { ValidationError } from "@/lib/errors";
import { datePartsInTz, localDateTimeToUtc, sameDayInTz } from "@/lib/dates";

/** A time span the technician logged, as UTC instants + whole minutes. */
export interface LoggedSpan {
  startedAt: Date; // UTC
  endedAt: Date | null; // UTC — only when a full start/end span was recorded
  minutes: number; // server-derived duration in whole minutes
}

/**
 * Resolve a validated time-entry input into the instants actually stored.
 *
 * - With a start AND end time: minutes are derived from the span (server-
 *   authoritative; any hours value is ignored) and endedAt is stored.
 * - With manual hours only: minutes = hours * 60 (whole-minute rounding),
 *   startedAt is the work date at 00:00 (org timezone) and endedAt stays null.
 *
 * Spans must end after they start and are confined to the work date (no
 * overnight entries in this slice). Duration guards (>0, ≤24h) live in the
 * repository so they also cover non-portal callers.
 */
export function resolveLoggedSpan(
  input: { workDate: string; hours?: number; startTime?: string; endTime?: string },
  timeZone: string,
): LoggedSpan {
  const startedAt = localDateTimeToUtc(`${input.workDate}T${input.startTime ?? "00:00"}`, timeZone);
  if (input.startTime && input.endTime) {
    const endedAt = localDateTimeToUtc(`${input.workDate}T${input.endTime}`, timeZone);
    if (!(endedAt.getTime() > startedAt.getTime())) {
      throw new ValidationError("End time must be after the start time.");
    }
    const minutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000);
    return { startedAt, endedAt, minutes };
  }
  return { startedAt, endedAt: null, minutes: Math.round(input.hours! * 60) };
}

/** "90" → "1 h 30 m", "45" → "45 m" — compact duration for lists and badges. */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} m`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} m`;
}

/** Customer label for field display ("Acme Corp" or "Jane Doe"). */
export function customerLabel(customer: { companyName: string | null; firstName: string | null; lastName: string | null }): string {
  if (customer.companyName?.trim()) return customer.companyName.trim();
  const first = customer.firstName?.trim() ?? "";
  const last = customer.lastName?.trim() ?? "";
  if (first || last) return `${first} ${last}`.trim();
  return "Unknown customer";
}

export interface TechnicianAppointmentItem {
  id: string;
  title: string;
  status: string;
  startsAt: string; // ISO (UTC)
  endsAt: string; // ISO (UTC)
  jobTitle: string | null;
  locationLabel: string | null;
}

export interface AppointmentDayGroup {
  /** Local calendar date key in the org timezone (YYYY-MM-DD), sorted ascending. */
  dateKey: string;
  label: string; // "Today" / "Tomorrow" / "Fri, Oct 9"
  isToday: boolean;
  items: TechnicianAppointmentItem[];
}

/**
 * Group the technician's appointments into org-timezone day buckets, ascending.
 * Pure (Intl-based) so it is DST-correct and unit-testable.
 */
export function groupAppointmentsByDay(
  items: readonly TechnicianAppointmentItem[],
  timeZone: string,
  now: Date = new Date(),
): AppointmentDayGroup[] {
  const byDay = new Map<string, { label: string; isToday: boolean; items: TechnicianAppointmentItem[] }>();
  for (const item of [...items].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const start = new Date(item.startsAt);
    const parts = datePartsInTz(start, timeZone);
    const dateKey = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    const isToday = sameDayInTz(start, now, timeZone);
    const tomorrow = datePartsInTz(new Date(now.getTime() + 86_400_000), timeZone);
    const isTomorrow =
      parts.year === tomorrow.year && parts.month === tomorrow.month && parts.day === tomorrow.day;
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(start);
    const label = isToday ? "Today" : isTomorrow ? "Tomorrow" : weekday;
    const bucket = byDay.get(dateKey) ?? { label, isToday, items: [] };
    bucket.items.push(item);
    byDay.set(dateKey, bucket);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateKey, bucket]) => ({ dateKey, ...bucket }));
}
