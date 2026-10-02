/** Payment lifecycle tests: the server-enforced transition map + pure helpers. */
import { describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  allowedNextPaymentStatuses,
  applyPaymentStatusTransition,
  canTransitionPaymentStatus,
  paymentMethodLabel,
  paymentStatusLabel,
} from "@/server/domain/payment-status";
import {
  INVOICE_PAYABLE_STATUSES,
  canInvoiceReceivePayment,
  invoiceStatusAfterPayment,
  paidAtForPaymentTransition,
} from "@/server/domain/invoice-payment-status";
import { PAYMENT_STATUSES as SCHEMA_STATUSES, PAYMENT_METHODS as SCHEMA_METHODS } from "@/features/payments/schemas";

const NOW = new Date("2026-10-02T12:00:00.000Z");

describe("PaymentStatus transition map", () => {
  it("declares exactly the five persisted statuses", () => {
    expect(PAYMENT_STATUSES).toEqual(["PENDING", "SUCCEEDED", "FAILED", "REFUNDED", "VOIDED"]);
  });
  it("matches the documented lifecycle", () => {
    expect(PAYMENT_TRANSITIONS).toEqual({
      PENDING: ["SUCCEEDED", "FAILED", "VOIDED"],
      SUCCEEDED: ["REFUNDED", "VOIDED"],
      FAILED: [],
      REFUNDED: [],
      VOIDED: [],
    });
  });
  it("exposes the map through allowedNextPaymentStatuses", () => {
    expect(allowedNextPaymentStatuses("PENDING")).toEqual(["SUCCEEDED", "FAILED", "VOIDED"]);
    expect(allowedNextPaymentStatuses("SUCCEEDED")).toEqual(["REFUNDED", "VOIDED"]);
    expect(allowedNextPaymentStatuses("VOIDED")).toEqual([]);
  });
  it("accepts every declared transition and rejects every undeclared one", () => {
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        if (PAYMENT_TRANSITIONS[from].includes(to)) {
          expect(canTransitionPaymentStatus(from, to)).toBe(true);
          expect(() => applyPaymentStatusTransition(from, to)).not.toThrow();
        } else {
          expect(canTransitionPaymentStatus(from, to)).toBe(false);
          expect(() => applyPaymentStatusTransition(from, to)).toThrow(ConflictError);
        }
      }
    }
  });
  it("keeps FAILED, REFUNDED and VOIDED terminal", () => {
    for (const terminal of ["FAILED", "REFUNDED", "VOIDED"] as const) {
      expect(allowedNextPaymentStatuses(terminal)).toEqual([]);
    }
  });
  it("labels statuses and methods for the UI", () => {
    expect(paymentStatusLabel("PARTIALLY_PAID" as never)).toBe("Partially Paid");
    expect(paymentMethodLabel("BANK_TRANSFER")).toBe("Bank transfer");
    expect(paymentMethodLabel("CASH")).toBe("Cash");
  });
  it("keeps the schema status/method lists in sync with the domain module", () => {
    expect(SCHEMA_STATUSES).toEqual(PAYMENT_STATUSES);
    expect(SCHEMA_METHODS).toEqual(PAYMENT_METHODS);
  });
});

describe("Invoice payment-money status (system-driven InvoiceStatus)", () => {
  it("marks only SENT, PARTIALLY_PAID and PAID as payable", () => {
    expect(INVOICE_PAYABLE_STATUSES).toEqual(["SENT", "PARTIALLY_PAID", "PAID"]);
    expect(canInvoiceReceivePayment("DRAFT")).toBe(false);
    expect(canInvoiceReceivePayment("VOID")).toBe(false);
    expect(canInvoiceReceivePayment("SENT")).toBe(true);
    expect(canInvoiceReceivePayment("PARTIALLY_PAID")).toBe(true);
    expect(canInvoiceReceivePayment("PAID")).toBe(true);
  });
  it("drives SENT/PARTIALLY_PAID → PAID when the balance reaches zero", () => {
    expect(invoiceStatusAfterPayment("SENT", 5000, 0)).toBe("PAID");
    expect(invoiceStatusAfterPayment("PARTIALLY_PAID", 10800, 0)).toBe("PAID");
  });
  it("drives SENT → PARTIALLY_PAID on a partial payment", () => {
    expect(invoiceStatusAfterPayment("SENT", 2000, 8000)).toBe("PARTIALLY_PAID");
  });
  it("returns SENT after a full reversal (paid back to zero)", () => {
    expect(invoiceStatusAfterPayment("PARTIALLY_PAID", 0, 5000)).toBe("SENT");
    expect(invoiceStatusAfterPayment("PAID", 0, 10800)).toBe("SENT");
  });
  it("keeps a fully-settled invoice PAID after a partial reversal", () => {
    // Reversal that still leaves the balance ≤ 0 cannot happen via the repo's
    // overpayment guard, but the pure helper must still tell the truth.
    expect(invoiceStatusAfterPayment("PAID", 500, -500)).toBe("PAID");
  });
  it("rejects DRAFT and VOID before any money moves", () => {
    expect(() => invoiceStatusAfterPayment("DRAFT", 1000, 0)).toThrow(ConflictError);
    expect(() => invoiceStatusAfterPayment("VOID", 1000, 0)).toThrow(ConflictError);
  });
  it("stamps paidAt when reaching PAID and clears it when leaving PAID", () => {
    expect(paidAtForPaymentTransition("SENT", "PAID", NOW)).toBe(NOW);
    expect(paidAtForPaymentTransition("PARTIALLY_PAID", "PAID", NOW)).toBe(NOW);
    expect(paidAtForPaymentTransition("PAID", "SENT", NOW)).toBeNull();
    expect(paidAtForPaymentTransition("PAID", "PARTIALLY_PAID", NOW)).toBeNull();
    expect(paidAtForPaymentTransition("SENT", "PARTIALLY_PAID", NOW)).toBeUndefined();
    expect(paidAtForPaymentTransition("PAID", "PAID", NOW)).toBeUndefined();
  });
});
