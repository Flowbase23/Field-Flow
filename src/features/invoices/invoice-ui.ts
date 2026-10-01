/**
 * Pure UI helpers for the Invoices routes and lifecycle controls. These
 * deliberately accept only URL/form values; organization identity always comes
 * from auth.
 */
import type { InvoiceStatus } from "@prisma/client";
import { INVOICE_STATUSES } from "@/server/domain/invoice-status";
import {
  allowedNextInvoiceStatuses,
  invoiceStatusLabel,
  type InvoiceStatusContext,
} from "@/server/domain/invoice-status";

export { INVOICE_STATUSES } from "@/server/domain/invoice-status";

export interface InvoiceListFilters {
  status?: InvoiceStatus;
  search?: string;
}
function isOneOf<T extends readonly string[]>(value: string | undefined, values: T): value is T[number] {
  return value !== undefined && (values as readonly string[]).includes(value);
}
/** Parse only recognized filter values, so malformed URLs behave like no filter. */
export function parseInvoiceListFilters(input: { status?: string; search?: string }): InvoiceListFilters {
  return {
    status: isOneOf(input.status, INVOICE_STATUSES) ? input.status : undefined,
    search: input.search?.trim() ? input.search.trim() : undefined,
  };
}
export type InvoiceStatusAction = { status: InvoiceStatus; label: string; destructive?: boolean };
const STATUS_ACTION_LABELS: Record<InvoiceStatus, Omit<InvoiceStatusAction, "status">> = {
  DRAFT: { label: "Move to draft" },
  SENT: { label: "Mark sent" },
  PARTIALLY_PAID: { label: "Mark partially paid" },
  PAID: { label: "Mark paid" },
  VOID: { label: "Void invoice", destructive: true },
  OVERDUE: { label: "Mark overdue (derived — never settable)", destructive: true },
};
/**
 * UI-facing labels for *server-valid* next transitions given the invoice's
 * money context. The page first gates this on INVOICE_STATUS_UPDATE; the server
 * action independently enforces both the transition map and the balance rule.
 */
export function invoiceStatusActions(
  currentStatus: InvoiceStatus,
  context: InvoiceStatusContext,
): InvoiceStatusAction[] {
  return allowedNextInvoiceStatuses(currentStatus, context).map((status) => ({ status, ...STATUS_ACTION_LABELS[status] }));
}
export { invoiceStatusLabel };
