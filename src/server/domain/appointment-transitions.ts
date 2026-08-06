/**
 * Appointment status transitions — server-enforced (design §3: "Status
 * transitions must be server-enforced (map of allowed transitions per status),
 * run in a transaction, and audited").
 *
 * This module is PURE (no DB, no server-only runtime imports — the only
 * @prisma/client import is a type) so it can be unit-tested in isolation and
 * imported by server actions, pages and client components (which use the const
 * arrays / labels / allowedNextAppointmentStatuses).
 *
 * Transition map (Slice 4 brief):
 *
 *   TENTATIVE ──► CONFIRMED ──► EN_ROUTE ──► IN_PROGRESS ──► COMPLETED
 *      │              │            │             │
 *      └──┬───────────┴───┬────────┴───┬─────────┘
 *         │               │            │
 *      CANCELLED (any non-terminal, from any live status)
 *   MISSED: manual only, from CONFIRMED | EN_ROUTE | IN_PROGRESS
 *
 * COMPLETED / MISSED / CANCELLED are terminal.
 *
 * Timestamp bookkeeping (feeds the dashboard's missed-appointments metric and
 * utilization later): actualStartAt is set the first time a status reaches
 * IN_PROGRESS, actualEndAt on COMPLETED, missedAt on MISSED.
 */
import { ConflictError } from "@/lib/errors";
import type { AppointmentStatus } from "@prisma/client";

/** All AppointmentStatus enum values, in schema order — shared with the Zod schema. */
export const APPOINTMENT_STATUSES = [
  "TENTATIVE",
  "CONFIRMED",
  "EN_ROUTE",
  "IN_PROGRESS",
  "COMPLETED",
  "MISSED",
  "CANCELLED",
] as const;

/** All AppointmentType enum values, in schema order — shared with the Zod schema. */
export const APPOINTMENT_TYPES = ["JOB", "BLOCKED_TIME", "TRAVEL", "OTHER"] as const;

/**
 * Allowed transitions keyed by current status. COMPLETED/MISSED/CANCELLED are
 * terminal (empty arrays). Same-status updates are handled as no-ops by callers.
 */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  TENTATIVE: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["EN_ROUTE", "IN_PROGRESS", "MISSED", "CANCELLED"],
  EN_ROUTE: ["IN_PROGRESS", "MISSED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "MISSED", "CANCELLED"],
  COMPLETED: [],
  MISSED: [],
  CANCELLED: [],
};

export function canTransitionAppointmentStatus(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_TRANSITIONS[from].includes(to);
}

/** The statuses reachable from `status` in one step (for UI action buttons). */
export function allowedNextAppointmentStatuses(status: AppointmentStatus): readonly AppointmentStatus[] {
  return APPOINTMENT_TRANSITIONS[status];
}

/** Fields that change when an appointment reaches a status. */
export interface AppointmentTransitionFields {
  actualStartAt?: Date | null;
  actualEndAt?: Date | null;
  missedAt?: Date | null;
}

/**
 * Compute the fields to persist for a transition `from → to`.
 *
 * Throws ConflictError when the transition is not allowed. Returns an empty
 * object for a no-op (from === to) so callers can skip the write + audit.
 * Timestamps are only SET on the first arrival (existing values are preserved
 * when the fields are merged in the repo — pass `undefined` to keep them).
 */
export function applyAppointmentTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
  options: { now?: Date } = {},
): AppointmentTransitionFields {
  if (from === to) return {};
  if (!canTransitionAppointmentStatus(from, to)) {
    throw new ConflictError(
      `Cannot move appointment from ${from} to ${to}. Allowed from ${from}: ${APPOINTMENT_TRANSITIONS[from].join(", ") || "none (terminal)"}.`,
    );
  }
  const now = options.now ?? new Date();
  const fields: AppointmentTransitionFields = {};
  if (to === "IN_PROGRESS") fields.actualStartAt = now;
  if (to === "COMPLETED") fields.actualEndAt = now;
  if (to === "MISSED") fields.missedAt = now;
  return fields;
}

/** Display helper — "TENTATIVE" → "Tentative", "EN_ROUTE" → "En route". */
export function appointmentStatusLabel(status: AppointmentStatus): string {
  return status
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Display helper — "BLOCKED_TIME" → "Blocked time". */
export function appointmentTypeLabel(type: (typeof APPOINTMENT_TYPES)[number]): string {
  return type
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
