/**
 * Server-enforced PaymentStatus lifecycle (pure, like invoice-status.ts).
 *
 * Persisted statuses and their transition map:
 *
 *   PENDING ─→ SUCCEEDED ─→ REFUNDED
 *     │             │
 *     │             └─→ VOIDED   (voiding a SUCCEEDED payment reverses its
 *     └─→ FAILED                  reconcile effect on the invoice — the
 *                                 invoice-side rules live in
 *                                 invoice-payment-status.ts)
 *
 * FAILED, REFUNDED and VOIDED are terminal. SUCCEEDED ─→ VOIDED and
 * SUCCEEDED ─→ REFUNDED both reverse the money: the payment keeps its row
 * (the ledger is append-only in spirit — amounts are never edited) and the
 * invoice's paidCents is decremented in the same transaction.
 *
 * Rules enforced here (server is authoritative; the UI only ever offers
 * `allowedNextPaymentStatuses`):
 * - Manual payments are recorded straight in SUCCEEDED; PENDING exists only
 *   for Stripe flows that confirm asynchronously.
 * - There is no generic "update": a ledger entry's amount/status/ids are never
 *   client-settable, and corrections go through VOIDED/REFUNDED.
 */
import type { PaymentMethod, PaymentStatus } from "@prisma/client";
import { ConflictError } from "@/lib/errors";

export const PAYMENT_STATUSES = [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "REFUNDED",
  "VOIDED",
] as const satisfies readonly PaymentStatus[];

export const PAYMENT_METHODS = [
  "CASH",
  "CHECK",
  "CARD",
  "ACH",
  "BANK_TRANSFER",
  "OTHER",
] as const satisfies readonly PaymentMethod[];

export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ["SUCCEEDED", "FAILED", "VOIDED"],
  SUCCEEDED: ["REFUNDED", "VOIDED"],
  FAILED: [],
  REFUNDED: [],
  VOIDED: [],
};

export function canTransitionPaymentStatus(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function allowedNextPaymentStatuses(status: PaymentStatus): readonly PaymentStatus[] {
  return PAYMENT_TRANSITIONS[status];
}

/**
 * Validates one payment-status transition. Succeeded payments may be both
 * REFUNDED (customer got their money back) and VOIDED (entry cancelled);
 * PENDING payments can go any way — no money has moved yet.
 */
export function applyPaymentStatusTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): Record<string, never> {
  if (!canTransitionPaymentStatus(from, to)) {
    throw new ConflictError(
      `Cannot move payment from ${from} to ${to}. Allowed from ${from}: ${
        PAYMENT_TRANSITIONS[from].join(", ") || "none (terminal)"
      }.`,
    );
  }
  return {};
}

export function paymentStatusLabel(status: PaymentStatus): string {
  return status.toLowerCase().split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function paymentMethodLabel(method: PaymentMethod): string {
  const labels: Record<PaymentMethod, string> = {
    CASH: "Cash",
    CHECK: "Check",
    CARD: "Card",
    ACH: "ACH",
    BANK_TRANSFER: "Bank transfer",
    OTHER: "Other",
  };
  return labels[method];
}
