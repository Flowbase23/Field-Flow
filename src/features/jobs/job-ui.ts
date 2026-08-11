/**
 * Pure UI helpers for the Jobs routes and lifecycle controls. These deliberately
 * accept only URL/form values; organization identity always comes from auth.
 */
import type { JobPriority, JobStatus } from "@prisma/client";
import { JOB_PRIORITIES, JOB_STATUSES } from "./schemas";
import { allowedNextJobStatuses, jobStatusLabel } from "@/server/domain/job-transitions";

export interface JobListFilters {
  status?: JobStatus;
  priority?: JobPriority;
}

function isOneOf<T extends readonly string[]>(value: string | undefined, values: T): value is T[number] {
  return value !== undefined && (values as readonly string[]).includes(value);
}

/** Parse only recognized filter values, so malformed URLs behave like no filter. */
export function parseJobListFilters(input: { status?: string; priority?: string }): JobListFilters {
  return {
    status: isOneOf(input.status, JOB_STATUSES) ? input.status : undefined,
    priority: isOneOf(input.priority, JOB_PRIORITIES) ? input.priority : undefined,
  } as JobListFilters;
}

export type JobStatusAction = { status: JobStatus; label: string; destructive?: boolean };

const STATUS_ACTION_LABELS: Record<JobStatus, Omit<JobStatusAction, "status">> = {
  DRAFT: { label: "Move to draft" },
  UNSCHEDULED: { label: "Move to unscheduled" },
  SCHEDULED: { label: "Mark scheduled" },
  EN_ROUTE: { label: "Mark en route" },
  IN_PROGRESS: { label: "Start job" },
  ON_HOLD: { label: "Place on hold" },
  COMPLETED: { label: "Complete job" },
  CANCELLED: { label: "Cancel job", destructive: true },
};

/**
 * UI-facing labels for *server-valid* next transitions. The page first gates
 * this on JOB_STATUS_UPDATE; the server action independently enforces both.
 */
export function jobStatusActions(currentStatus: JobStatus): JobStatusAction[] {
  return allowedNextJobStatuses(currentStatus).map((status) => ({ status, ...STATUS_ACTION_LABELS[status] }));
}

export function jobTypeLabel(value: string): string {
  return value.toLowerCase().split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function jobPriorityLabel(value: string): string {
  return jobTypeLabel(value);
}

export { jobStatusLabel };
