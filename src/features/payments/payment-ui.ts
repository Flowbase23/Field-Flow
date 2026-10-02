/**
 * Client-safe UI helpers for the payment feature (pure). Mirrors
 * invoice-ui.ts/estimate-ui.ts: labels + filter parsing only — all money and
 * status WRITES stay server-side behind the tenant repo and permission gates.
 */
import type { PaymentMethod, PaymentStatus } from "@prisma/client";
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  allowedNextPaymentStatuses,
  paymentStatusLabel,
} from "@/server/domain/payment-status";

export { PAYMENT_METHODS, PAYMENT_STATUSES, paymentStatusLabel };
export type { PaymentMethod, PaymentStatus };

export interface PaymentListFilters {
  status?: PaymentStatus;
  method?: PaymentMethod;
}
function isOneOf<T extends readonly string[]>(value: string | undefined, values: T): value is T[number] {
  return value !== undefined && (values as readonly string[]).includes(value);
}
/** Parse only recognized filter values, so malformed URLs behave like no filter. */
export function parsePaymentListFilters(input: { status?: string; method?: string }): PaymentListFilters {
  return {
    status: isOneOf(input.status, PAYMENT_STATUSES) ? input.status : undefined,
    method: isOneOf(input.method, PAYMENT_METHODS) ? input.method : undefined,
  };
}
export type PaymentRowAction = { status: PaymentStatus; label: string; destructive?: boolean };
/** Labels are keyed by the TARGET status of the row action. */
const ROW_ACTION_LABELS: Record<PaymentStatus, Omit<PaymentRowAction, "status">> = {
  PENDING: { label: "" },
  SUCCEEDED: { label: "" }, // system-driven (Stripe webhook confirm) — never a button
  FAILED: { label: "" },
  REFUNDED: { label: "Refund payment", destructive: true },
  VOIDED: { label: "Void payment", destructive: true },
};
/**
 * UI-facing actions for *user-initiated* corrections of one payment row.
 * PENDING offers VOID only — its SUCCEEDED transition is system-driven
 * (Stripe webhook confirm), never a button. A SUCCEEDED payment offers both
 * REFUND and VOID. The page first gates on PAYMENT_REFUND/PAYMENT_VOID; the
 * server action independently re-enforces the transition map.
 */
export function paymentRowActions(currentStatus: PaymentStatus): PaymentRowAction[] {
  return allowedNextPaymentStatuses(currentStatus)
    .filter((status) => !(currentStatus === "PENDING" && status === "SUCCEEDED"))
    .map((status) => ({ status, ...ROW_ACTION_LABELS[status] }))
    .filter((action) => action.label !== "");
}
