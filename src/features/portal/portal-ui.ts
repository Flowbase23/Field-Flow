/**
 * Client-safe display helpers for the customer portal (Slice P2-S4). Pure
 * module — no server imports — so portal pages and client components can
 * bundle it. The server actions re-check every guard; these only shape what
 * the page OFFERS to show.
 */
import type { InvoiceStatus } from "@prisma/client";
import { canInvoiceReceivePayment } from "@/server/domain/invoice-payment-status";
import { estimateStatusLabel } from "@/server/domain/estimate-status";
import { invoiceStatusLabel } from "@/server/domain/invoice-status";

/** Customer-facing status label (reuses the internal label maps). */
export function portalStatusLabel(status: string): string {
  return estimateStatusLabel(status);
}

export function portalInvoiceStatusLabel(status: InvoiceStatus): string {
  return invoiceStatusLabel(status);
}

/**
 * What the invoice portal page may OFFER, mirroring getPayableInvoice's
 * guards (the server action re-enforces them):
 * - "paid"    — nothing owed (balance ≤ 0): show the paid-in-full state;
 * - "payable" — a payment can be opened (SENT/PARTIALLY_PAID and friends);
 * - "blocked" — DRAFT/VOID: the page explains the document isn't payable.
 */
export function portalInvoicePayOffer(invoice: { status: string; balanceCents: number }): "payable" | "paid" | "blocked" {
  if (invoice.balanceCents <= 0) return "paid";
  return canInvoiceReceivePayment(invoice.status as InvoiceStatus) ? "payable" : "blocked";
}

/** "Jane Smith" / "Smith Plumbing" — the same display rule the app uses. */
export function portalCustomerName(customer: { firstName: string | null; lastName: string | null; companyName: string | null }): string {
  return (customer.companyName ?? [customer.firstName, customer.lastName].filter(Boolean).join(" ")) || "Customer";
}
