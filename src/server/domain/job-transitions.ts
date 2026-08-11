/**
 * Server-enforced JobStatus lifecycle. This module is pure so transition policy
 * can be tested independently from auth, Prisma, and UI code.
 */
import type { JobStatus } from "@prisma/client";
import { ConflictError } from "@/lib/errors";

export const JOB_STATUSES = [
  "DRAFT", "UNSCHEDULED", "SCHEDULED", "EN_ROUTE", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED",
] as const;

export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  DRAFT: ["UNSCHEDULED", "CANCELLED"],
  UNSCHEDULED: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["EN_ROUTE", "IN_PROGRESS", "CANCELLED"],
  EN_ROUTE: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["ON_HOLD", "COMPLETED", "CANCELLED"],
  ON_HOLD: ["IN_PROGRESS", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export interface JobTransitionFields {
  completedAt?: Date;
  cancelledAt?: Date;
}

export function canTransitionJobStatus(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function allowedNextJobStatuses(status: JobStatus): readonly JobStatus[] {
  return JOB_TRANSITIONS[status];
}

/**
 * Computes lifecycle timestamp changes for one valid transition. A same-status
 * request is a no-op; completedAt is written only on COMPLETED and cancelledAt
 * only on CANCELLED. Terminal states have no outgoing transitions.
 */
export function applyJobStatusTransition(
  from: JobStatus,
  to: JobStatus,
  options: { now?: Date } = {},
): JobTransitionFields {
  if (from === to) return {};
  if (!canTransitionJobStatus(from, to)) {
    throw new ConflictError(
      `Cannot move job from ${from} to ${to}. Allowed from ${from}: ${JOB_TRANSITIONS[from].join(", ") || "none (terminal)"}.`,
    );
  }
  const now = options.now ?? new Date();
  if (to === "COMPLETED") return { completedAt: now };
  if (to === "CANCELLED") return { cancelledAt: now };
  return {};
}

export function jobStatusLabel(status: JobStatus): string {
  return status.toLowerCase().split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
