/**
 * Technician conflict detection for appointments (Phase 1, Slice 4).
 *
 * PURE module (no DB, no server-only imports) — unit-tested in isolation and
 * used by the appointment server actions before every create/update.
 *
 * Model: an appointment occupies [startsAt, endsAt) plus optional travel
 * buffers (travelMinutesBefore before the start, travelMinutesAfter after the
 * end). Two appointments CONFLICT for a technician when their effective spans
 * intersect: effectiveA.start < effectiveB.end && effectiveB.start < effectiveA.end
 * (half-open intervals — back-to-back appointments at the same instant do NOT
 * conflict). Conflict is per-technician: appointments on different technicians
 * never conflict.
 *
 * Policy (Slice 4 brief): on create/update, overlapping appointments for the
 * SAME technician are rejected with a clear error naming the conflicting
 * appointment, UNLESS the caller holds SCHEDULE_UPDATE and passes an explicit
 * allowOverlap flag (Dispatcher/Admin override). The override decision lives in
 * the server actions; this module only reports the conflicts.
 */
import { formatTimeInTz } from "@/lib/dates";

/** A time span that may carry travel buffers (an appointment or candidate). */
export interface Span {
  startsAt: Date;
  endsAt: Date;
  travelMinutesBefore?: number;
  travelMinutesAfter?: number;
}

/** An existing appointment row (technicianIds flattened from the join rows). */
export interface ExistingAppointment extends Span {
  id: string;
  title: string;
  technicianIds: string[];
}

export interface AppointmentConflict {
  /** The EXISTING appointment that overlaps. */
  appointmentId: string;
  appointmentTitle: string;
  /** The technician (of the candidate's set) that is double-booked. */
  technicianId: string;
  /** Exact overlap of the two effective spans. */
  overlapStart: Date;
  overlapEnd: Date;
}

/** The span actually occupied on the calendar, including travel buffers. */
export function effectiveSpan(span: Span): { start: Date; end: Date } {
  return {
    start: new Date(span.startsAt.getTime() - (span.travelMinutesBefore ?? 0) * 60_000),
    end: new Date(span.endsAt.getTime() + (span.travelMinutesAfter ?? 0) * 60_000),
  };
}

/** Half-open [a.start, a.end) vs [b.start, b.end) intersection test. */
export function spansOverlap(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** The intersection of two spans, or null when they do not overlap. */
export function overlapRange(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
): { start: Date; end: Date } | null {
  const startMs = Math.max(a.start.getTime(), b.start.getTime());
  const endMs = Math.min(a.end.getTime(), b.end.getTime());
  return startMs < endMs ? { start: new Date(startMs), end: new Date(endMs) } : null;
}

/**
 * Find every existing appointment that conflicts with the candidate for one of
 * the candidate's technicians. `existing` should be the tenant-scoped set
 * returned by the appointment repo's findOverlapping query (it may contain
 * appointments that do NOT actually conflict — precise buffer-aware checks
 * happen here).
 */
export function findTechnicianConflicts(
  candidate: Span & { technicianIds: string[] },
  existing: readonly ExistingAppointment[],
): AppointmentConflict[] {
  const candidateSpan = effectiveSpan(candidate);
  const conflicts: AppointmentConflict[] = [];
  for (const other of existing) {
    const otherSpan = effectiveSpan(other);
    const overlap = overlapRange(candidateSpan, otherSpan);
    if (!overlap) continue;
    for (const technicianId of candidate.technicianIds) {
      if (other.technicianIds.includes(technicianId)) {
        conflicts.push({
          appointmentId: other.id,
          appointmentTitle: other.title,
          technicianId,
          overlapStart: overlap.start,
          overlapEnd: overlap.end,
        });
      }
    }
  }
  return conflicts;
}

/**
 * A clear, operator-actionable message naming the conflicting appointment.
 * `technicianName` is the display name of the double-booked technician
 * (resolved by the caller from the tenant-scoped technician repo).
 */
export function conflictMessage(
  conflict: AppointmentConflict,
  technicianName: string,
  timeZone: string,
): string {
  return (
    `Appointment conflicts with "${conflict.appointmentTitle}" (technician ${technicianName}, ` +
    `${formatTimeInTz(conflict.overlapStart, timeZone)}–${formatTimeInTz(conflict.overlapEnd, timeZone)} in ${timeZone}). ` +
    `Reschedule one of them, or use the allow-overlap override (requires SCHEDULE_UPDATE).`
  );
}
