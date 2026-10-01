/** Pure InvoiceStatus transition policy (src/server/domain/invoice-status.ts). */
import { describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import {
  allowedNextInvoiceStatuses,
  applyInvoiceStatusTransition,
  canTransitionInvoiceStatus,
  effectiveInvoiceStatus,
  INVOICE_TRANSITIONS,
} from "@/server/domain/invoice-status";

const unpaid = { balanceCents: 12000, paidCents: 0 };
const partial = { balanceCents: 7000, paidCents: 5000 };
const settled = { balanceCents: 0, paidCents: 12000 };

describe("invoice transition map", () => {
  it("follows the money progression with VOID from the three open states", () => {
    expect(INVOICE_TRANSITIONS.DRAFT).toEqual(["SENT", "VOID"]);
    expect(INVOICE_TRANSITIONS.SENT).toEqual(["PARTIALLY_PAID", "PAID", "VOID"]);
    expect(INVOICE_TRANSITIONS.PARTIALLY_PAID).toEqual(["PAID", "VOID"]);
    expect(INVOICE_TRANSITIONS.PAID).toEqual([]);
    expect(INVOICE_TRANSITIONS.VOID).toEqual([]);
  });
  it("voids are allowed from DRAFT/SENT/PARTIALLY_PAID and nowhere else", () => {
    expect(canTransitionInvoiceStatus("DRAFT", "VOID", unpaid)).toBe(true);
    expect(canTransitionInvoiceStatus("SENT", "VOID", unpaid)).toBe(true);
    expect(canTransitionInvoiceStatus("PARTIALLY_PAID", "VOID", partial)).toBe(true);
    expect(canTransitionInvoiceStatus("PAID", "VOID", settled)).toBe(false);
    expect(canTransitionInvoiceStatus("VOID", "VOID", settled)).toBe(false);
  });
  it("marks PAID only when the balance reaches zero (any open state)", () => {
    expect(canTransitionInvoiceStatus("SENT", "PAID", settled)).toBe(true);
    expect(canTransitionInvoiceStatus("PARTIALLY_PAID", "PAID", settled)).toBe(true);
    expect(canTransitionInvoiceStatus("SENT", "PAID", unpaid)).toBe(false);
    expect(canTransitionInvoiceStatus("SENT", "PAID", partial)).toBe(false);
    expect(canTransitionInvoiceStatus("DRAFT", "PAID", settled)).toBe(false);
  });
  it("marks PARTIALLY_PAID only with money on the books and balance outstanding", () => {
    expect(canTransitionInvoiceStatus("SENT", "PARTIALLY_PAID", partial)).toBe(true);
    expect(canTransitionInvoiceStatus("SENT", "PARTIALLY_PAID", unpaid)).toBe(false);
    expect(canTransitionInvoiceStatus("SENT", "PARTIALLY_PAID", settled)).toBe(false);
    expect(canTransitionInvoiceStatus("DRAFT", "PARTIALLY_PAID", partial)).toBe(false);
  });
  it("throws a conflict with a balance explanation for an invalid PAID", () => {
    expect(() => applyInvoiceStatusTransition("SENT", "PAID", unpaid)).toThrow(/balance reaches zero/);
  });
  it("throws a conflict for out-of-map moves (including the derived OVERDUE)", () => {
    expect(() => applyInvoiceStatusTransition("SENT", "OVERDUE", unpaid)).toThrow(/Allowed from SENT/);
    expect(() => applyInvoiceStatusTransition("PAID", "VOID", settled)).toThrow(/Allowed from PAID/);
    expect(() => applyInvoiceStatusTransition("DRAFT", "PARTIALLY_PAID", partial)).toThrow(ConflictError);
  });
  it("a same-status request is a no-op and stamps paidAt only on reaching PAID", () => {
    expect(applyInvoiceStatusTransition("SENT", "SENT", unpaid)).toEqual({});
    const now = new Date("2026-10-01T12:00:00.000Z");
    expect(applyInvoiceStatusTransition("SENT", "PAID", settled, { now })).toEqual({ paidAt: now });
    expect(applyInvoiceStatusTransition("DRAFT", "SENT", unpaid, { now })).toEqual({});
    expect(applyInvoiceStatusTransition("SENT", "VOID", unpaid, { now })).toEqual({});
  });
  it("allowedNextInvoiceStatuses filters the map by the money context", () => {
    // Unpaid: PARTIALLY_PAID needs money on the books; PAID needs a zero balance.
    expect(allowedNextInvoiceStatuses("SENT", unpaid)).toEqual(["VOID"]);
    // Settled: PAID unlocks; PARTIALLY_PAID makes no sense with a zero balance.
    expect(allowedNextInvoiceStatuses("SENT", settled)).toEqual(["PAID", "VOID"]);
    expect(allowedNextInvoiceStatuses("PAID", settled)).toEqual([]);
  });
});

describe("effectiveInvoiceStatus — OVERDUE is derived, never settable", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");
  const overdueDue = new Date("2026-09-01T00:00:00.000Z");
  const futureDue = new Date("2026-11-01T00:00:00.000Z");
  it("derives OVERDUE for past-due open invoices with a balance", () => {
    expect(effectiveInvoiceStatus("SENT", overdueDue, unpaid.balanceCents, now)).toBe("OVERDUE");
    expect(effectiveInvoiceStatus("PARTIALLY_PAID", overdueDue, partial.balanceCents, now)).toBe("OVERDUE");
  });
  it("never derives OVERDUE for paid/void/draft invoices or settled balances", () => {
    expect(effectiveInvoiceStatus("DRAFT", overdueDue, unpaid.balanceCents, now)).toBe("DRAFT");
    expect(effectiveInvoiceStatus("PAID", overdueDue, 0, now)).toBe("PAID");
    expect(effectiveInvoiceStatus("VOID", overdueDue, 0, now)).toBe("VOID");
    expect(effectiveInvoiceStatus("SENT", overdueDue, 0, now)).toBe("SENT");
  });
  it("needs BOTH a past dueAt and an outstanding balance", () => {
    expect(effectiveInvoiceStatus("SENT", futureDue, unpaid.balanceCents, now)).toBe("SENT");
    expect(effectiveInvoiceStatus("SENT", null, unpaid.balanceCents, now)).toBe("SENT");
  });
});
