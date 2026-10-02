/**
 * System-driven InvoiceStatus changes caused by the payment ledger (pure).
 *
 * The user-facing transition map in invoice-status.ts is untouched: payments
 * are the ONE system flow allowed to move Invoice.status, because the stored
 * status must always tell the truth about the money (a PAID invoice with an
 * outstanding balance, or a SENT invoice with paidCents > 0, would be a lie).
 *
 * Applying a payment (invoice SENT or PARTIALLY_PAID):
 *   newBalance ≤ 0  → PAID            (paidAt stamped by the repository)
 *   paid > 0        → PARTIALLY_PAID
 *
 * Reversing a payment (REFUNDED / VOIDED of a SUCCEEDED payment):
 *   newBalance ≤ 0  → PAID            (still fully settled)
 *   paid > 0        → PARTIALLY_PAID
 *   paid == 0       → SENT            (fully reversed — the invoice opens
 *                                      again; paidAt is cleared when it
 *                                      leaves PAID)
 *
 * DRAFT and VOID invoices never receive payments — rejected before any write.
 * PAID invoices accept only reversals (applying more money to a PAID invoice
 * is an overpayment and is rejected by the repository's balance guard).
 */
import type { InvoiceStatus } from "@prisma/client";
import { ConflictError } from "@/lib/errors";

/** Invoice statuses that can receive (or have reversed) payment money. */
export const INVOICE_PAYABLE_STATUSES = [
  "SENT",
  "PARTIALLY_PAID",
  "PAID",
] as const satisfies readonly InvoiceStatus[];

export function canInvoiceReceivePayment(status: InvoiceStatus): boolean {
  return (INVOICE_PAYABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * The invoice status after its paidCents/balanceCents change to the given
 * values. Throws ConflictError for DRAFT/VOID (never payable) — callers must
 * check `canInvoiceReceivePayment` first when they want a softer path.
 */
export function invoiceStatusAfterPayment(
  from: InvoiceStatus,
  paidCents: number,
  balanceCents: number,
): InvoiceStatus {
  if (!canInvoiceReceivePayment(from)) {
    throw new ConflictError(
      from === "DRAFT"
        ? "A draft invoice cannot receive payments. Send it first."
        : "A voided invoice cannot receive payments.",
    );
  }
  if (balanceCents <= 0) return "PAID";
  if (paidCents > 0) return "PARTIALLY_PAID";
  return "SENT";
}

/**
 * paidAt handling for a system-driven money transition:
 * - reaching PAID from another status → stamp `now` (system-set);
 * - leaving PAID (full reversal)      → clear (null);
 * - anything else                     → undefined (leave the column alone).
 */
export function paidAtForPaymentTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
  now: Date,
): Date | null | undefined {
  if (to === "PAID" && from !== "PAID") return now;
  if (from === "PAID" && to !== "PAID") return null;
  return undefined;
}
