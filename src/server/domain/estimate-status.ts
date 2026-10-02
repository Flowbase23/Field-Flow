/**
 * Server-enforced EstimateStatus lifecycle (pure, like invoice-status.ts).
 *
 * Persisted statuses and their transition map:
 *
 *   DRAFT ─→ SENT ─→ ACCEPTED
 *     │        │
 *     │        └─→ DECLINED
 *     └────── →──┴─→ VOID   (VOID from DRAFT or SENT only)
 *
 * ACCEPTED, DECLINED and VOID are terminal — an outcome is recorded once.
 * There is no back-to-draft path: corrections after SENT go through a new
 * estimate (same as a corrected invoice would).
 *
 * Rules enforced here (server is authoritative; the UI only ever offers
 * `allowedNextEstimateStatuses`):
 * - SENT stamps `sentAt`, ACCEPTED stamps `acceptedAt`, DECLINED stamps
 *   `declinedAt` — all system-set timestamps, never client-supplied.
 * - VOID is legal only from DRAFT/SENT (a decision was never recorded).
 *
 * EXPIRED IS DERIVED, NOT SETTABLE: there is no `EXPIRED` transition target and
 * `setStatus` rejects it. `effectiveEstimateStatus` computes it on read when a
 * SENT estimate is past its validUntil. Nothing ever persists EXPIRED (the DB
 * column keeps SENT), mirroring OVERDUE for invoices.
 */
import type { EstimateStatus } from "@prisma/client";
import { ConflictError } from "@/lib/errors";

export const ESTIMATE_STATUSES = [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "DECLINED",
  "VOID",
] as const satisfies readonly EstimateStatus[];

export const ESTIMATE_SETTABLE_STATUSES = [...ESTIMATE_STATUSES] as const;

/** EXPIRED exists only as a derived display/filter value — never persisted. */
export const ESTIMATE_DISPLAY_STATUSES = [...ESTIMATE_STATUSES, "EXPIRED"] as const;
export type EstimateDisplayStatus = (typeof ESTIMATE_DISPLAY_STATUSES)[number];

export const ESTIMATE_TRANSITIONS: Record<EstimateStatus, readonly EstimateStatus[]> = {
  DRAFT: ["SENT", "VOID"],
  SENT: ["ACCEPTED", "DECLINED", "VOID"],
  ACCEPTED: [],
  DECLINED: [],
  VOID: [],
};

export function canTransitionEstimateStatus(from: EstimateStatus, to: EstimateStatus): boolean {
  return ESTIMATE_TRANSITIONS[from].includes(to);
}

export function allowedNextEstimateStatuses(status: EstimateStatus): readonly EstimateStatus[] {
  return ESTIMATE_TRANSITIONS[status];
}

export interface EstimateTransitionFields {
  /** System-stamped when the estimate reaches SENT / ACCEPTED / DECLINED. */
  sentAt?: Date;
  acceptedAt?: Date;
  declinedAt?: Date;
}

/** The timestamp each target transition stamps (system-set, never a client value). */
const TRANSITION_STAMP: Partial<Record<EstimateStatus, keyof EstimateTransitionFields>> = {
  SENT: "sentAt",
  ACCEPTED: "acceptedAt",
  DECLINED: "declinedAt",
};

/**
 * Computes field changes for one valid transition. A same-status request is a
 * no-op; the target stamp (sentAt/acceptedAt/declinedAt) is system-set.
 */
export function applyEstimateStatusTransition(
  from: EstimateStatus,
  to: EstimateStatus,
  options: { now?: Date } = {},
): EstimateTransitionFields {
  if (from === to) return {};
  if (!canTransitionEstimateStatus(from, to)) {
    throw new ConflictError(
      `Cannot move estimate from ${from} to ${to}. Allowed from ${from}: ${ESTIMATE_TRANSITIONS[from].join(", ") || "none (terminal)"}.`,
    );
  }
  const stampKey = TRANSITION_STAMP[to];
  if (!stampKey) return {};
  return { [stampKey]: options.now ?? new Date() } as EstimateTransitionFields;
}

/**
 * Derived display status: EXPIRED replaces SENT on read when the estimate is
 * past its validUntil. Never persisted, never accepted by setStatus. An
 * ACCEPTED/DECLINED/VOID estimate is never EXPIRED, and an estimate without a
 * validUntil never expires.
 */
export function effectiveEstimateStatus(
  status: EstimateStatus,
  validUntil: Date | null,
  now: Date = new Date(),
): EstimateDisplayStatus {
  if (status === "SENT" && validUntil !== null && validUntil.getTime() < now.getTime()) {
    return "EXPIRED";
  }
  return status;
}

export function estimateStatusLabel(status: string): string {
  return status.toLowerCase().split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
