/**
 * Pure UI helpers for the Estimates routes and lifecycle controls. These
 * deliberately accept only URL/form values; organization identity always comes
 * from auth.
 */
import type { EstimateStatus } from "@prisma/client";
import {
  ESTIMATE_DISPLAY_STATUSES,
  allowedNextEstimateStatuses,
  estimateStatusLabel,
  type EstimateDisplayStatus,
} from "@/server/domain/estimate-status";

export { ESTIMATE_DISPLAY_STATUSES, estimateStatusLabel };

export interface EstimateListFilters {
  status?: EstimateDisplayStatus;
  search?: string;
}
function isOneOf<T extends readonly string[]>(value: string | undefined, values: T): value is T[number] {
  return value !== undefined && (values as readonly string[]).includes(value);
}
/** Parse only recognized filter values, so malformed URLs behave like no filter. */
export function parseEstimateListFilters(input: { status?: string; search?: string }): EstimateListFilters {
  return {
    status: isOneOf(input.status, ESTIMATE_DISPLAY_STATUSES) ? input.status : undefined,
    search: input.search?.trim() ? input.search.trim() : undefined,
  };
}
export type EstimateStatusAction = { status: EstimateStatus; label: string; destructive?: boolean };
// Keys are the PERSISTED statuses only — EXPIRED is derived on read and never
// offered as an action (allowedNextEstimateStatuses returns persisted targets).
const STATUS_ACTION_LABELS: Record<EstimateStatus, Omit<EstimateStatusAction, "status">> = {
  DRAFT: { label: "Move to draft" },
  SENT: { label: "Mark sent" },
  ACCEPTED: { label: "Mark accepted" },
  DECLINED: { label: "Mark declined" },
  VOID: { label: "Void estimate", destructive: true },
};
/**
 * UI-facing labels for *server-valid* next transitions. The page first gates
 * this on ESTIMATE_STATUS_UPDATE; the server action independently enforces the
 * transition map (and stamps sentAt/acceptedAt/declinedAt).
 */
export function estimateStatusActions(currentStatus: EstimateStatus): EstimateStatusAction[] {
  return allowedNextEstimateStatuses(currentStatus).map((status) => ({ status, ...STATUS_ACTION_LABELS[status] }));
}
