/**
 * Server-enforced InvoiceStatus lifecycle (pure, like job-transitions.ts).
 *
 * Persisted statuses and their transition map:
 *
 *   DRAFT ─→ SENT ─→ PARTIALLY_PAID ─→ PAID
 *     │        │            │
 *     └────────┴────────────┴─→ VOID   (never from PAID/VOID)
 *
 * The money progression is linear; a full payment may skip PARTIALLY_PAID
 * (SENT ─→ PAID is legal) so that a paid-in-full invoice does not have to fake
 * an intermediate partial state. PARTIALLY_PAID is reserved for invoices that
 * actually have some — but not all — of their total paid.
 *
 * Rules enforced here (server is authoritative; the UI only ever offers
 * `allowedNextInvoiceStatuses`):
 * - `PAID` only when the balance has reached 0 (paidCents covers the total).
 * - `PARTIALLY_PAID` only when paidCents > 0 and balanceCents > 0 — marking an
 *   untouched invoice partially paid would be a lie.
 * - `VOID` is allowed from DRAFT/SENT/PARTIALLY_PAID, never from PAID or VOID.
 *
 * OVERDUE IS DERIVED, NOT SETTABLE: there is no `OVERDUE` transition target and
 * `setStatus` rejects it. `effectiveInvoiceStatus` computes it on read when a
 * SENT/PARTIALLY_PAID invoice is past its dueAt with an outstanding balance.
 * Nothing ever persists OVERDUE (the DB column keeps SENT/PARTIALLY_PAID).
 */
import type { InvoiceStatus } from "@prisma/client";
import { ConflictError } from "@/lib/errors";

export const INVOICE_STATUSES = [
  "DRAFT",
  "SENT",
  "PARTIALLY_PAID",
  "PAID",
  "VOID",
  "OVERDUE",
] as const satisfies readonly InvoiceStatus[];

/** Statuses a user may request; OVERDUE is derived on read and never settable. */
export const INVOICE_SETTABLE_STATUSES = [
  "DRAFT",
  "SENT",
  "PARTIALLY_PAID",
  "PAID",
  "VOID",
] as const;

export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  DRAFT: ["SENT", "VOID"],
  SENT: ["PARTIALLY_PAID", "PAID", "VOID"],
  PARTIALLY_PAID: ["PAID", "VOID"],
  PAID: [],
  VOID: [],
  // OVERDUE is not a persisted state — no outgoing transitions by construction.
  OVERDUE: [],
};

/** Money context needed to validate balance-dependent transitions. */
export interface InvoiceStatusContext {
  /** Current outstanding balance in integer cents (totalCents − paidCents). */
  balanceCents: number;
  /** Amount already recorded as paid in integer cents. */
  paidCents: number;
}

export function canTransitionInvoiceStatus(
  from: InvoiceStatus,
  to: InvoiceStatus,
  context: InvoiceStatusContext = { balanceCents: 0, paidCents: 0 },
): boolean {
  if (!INVOICE_TRANSITIONS[from].includes(to)) return false;
  if (to === "PAID" && context.balanceCents !== 0) return false;
  if (to === "PARTIALLY_PAID" && !(context.paidCents > 0 && context.balanceCents > 0)) return false;
  return true;
}

export function allowedNextInvoiceStatuses(
  status: InvoiceStatus,
  context: InvoiceStatusContext = { balanceCents: 0, paidCents: 0 },
): readonly InvoiceStatus[] {
  return INVOICE_TRANSITIONS[status].filter((to) => canTransitionInvoiceStatus(status, to, context));
}

export interface InvoiceTransitionFields {
  /** paidAt is written by the system when an invoice reaches PAID. */
  paidAt?: Date;
}

/**
 * Computes field changes for one valid transition. A same-status request is a
 * no-op; reaching PAID stamps paidAt (never a client-supplied value).
 */
export function applyInvoiceStatusTransition(
  from: InvoiceStatus,
  to: InvoiceStatus,
  context: InvoiceStatusContext,
  options: { now?: Date } = {},
): InvoiceTransitionFields {
  if (from === to) return {};
  if (!canTransitionInvoiceStatus(from, to, context)) {
    if (to === "PAID" && context.balanceCents !== 0) {
      throw new ConflictError(
        `An invoice can be marked PAID only when its balance reaches zero. Current balance: ${context.balanceCents} cents.`,
      );
    }
    if (to === "PARTIALLY_PAID" && !(context.paidCents > 0 && context.balanceCents > 0)) {
      throw new ConflictError(
        "An invoice can be marked PARTIALLY_PAID only after a partial payment is recorded.",
      );
    }
    throw new ConflictError(
      `Cannot move invoice from ${from} to ${to}. Allowed from ${from}: ${INVOICE_TRANSITIONS[from].join(", ") || "none (terminal)"}.`,
    );
  }
  return to === "PAID" ? { paidAt: options.now ?? new Date() } : {};
}

/**
 * Derived display status: OVERDUE replaces SENT/PARTIALLY_PAID on read when the
 * invoice is past due with an outstanding balance. Never persisted, never
 * accepted by setStatus. A PAID or VOID invoice is never OVERDUE, and a
 * past-due invoice with a zero balance (paid in full) is not either.
 */
export function effectiveInvoiceStatus(
  status: InvoiceStatus,
  dueAt: Date | null,
  balanceCents: number,
  now: Date = new Date(),
): InvoiceStatus {
  if (
    (status === "SENT" || status === "PARTIALLY_PAID") &&
    dueAt !== null &&
    dueAt.getTime() < now.getTime() &&
    balanceCents > 0
  ) {
    return "OVERDUE";
  }
  return status;
}

export function invoiceStatusLabel(status: InvoiceStatus): string {
  return status.toLowerCase().split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
