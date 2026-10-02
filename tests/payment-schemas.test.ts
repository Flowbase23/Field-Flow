/** Zod contract tests for the payment slice (client-safe schemas). */
import { describe, expect, it } from "vitest";
import {
  paymentListActionSchema,
  paymentReadSchema,
  paymentRecordSchema,
  paymentStripeCheckoutSchema,
} from "@/features/payments/schemas";

const CUID = "cjld93cjlb000000c4bmu1jn";
const baseRecord = { invoiceId: CUID, customerId: null, amountCents: 12500, method: "CASH", notes: null };

describe("paymentRecordSchema", () => {
  it("accepts a minimal manual payment record", () => {
    const parsed = paymentRecordSchema.parse(baseRecord);
    expect(parsed).toEqual(baseRecord);
  });
  it("defaults notes and customerId to null", () => {
    const parsed = paymentRecordSchema.parse({ invoiceId: CUID, amountCents: 100, method: "CHECK" });
    expect(parsed.customerId).toBeNull();
    expect(parsed.notes).toBeNull();
  });
  it("rejects zero, negative and fractional amounts", () => {
    expect(() => paymentRecordSchema.parse({ ...baseRecord, amountCents: 0 })).toThrow();
    expect(() => paymentRecordSchema.parse({ ...baseRecord, amountCents: -100 })).toThrow();
    expect(() => paymentRecordSchema.parse({ ...baseRecord, amountCents: 12.5 })).toThrow();
    expect(() => paymentRecordSchema.parse({ ...baseRecord, amountCents: 12.505 })).toThrow();
  });
  it("rejects unknown/forbidden fields (strict payloads — no status, ids or Stripe identifiers)", () => {
    expect(() => paymentRecordSchema.parse({ ...baseRecord, status: "SUCCEEDED" })).toThrow();
    expect(() => paymentRecordSchema.parse({ ...baseRecord, organizationId: "org-x" })).toThrow();
    expect(() => paymentRecordSchema.parse({ ...baseRecord, appliedAt: new Date().toISOString() })).toThrow();
    expect(() => paymentRecordSchema.parse({ ...baseRecord, stripePaymentIntentId: "pi_x" })).toThrow();
    expect(() => paymentRecordSchema.parse({ ...baseRecord, id: CUID })).toThrow();
  });
  it("rejects a bad method or malformed cuid", () => {
    expect(() => paymentRecordSchema.parse({ ...baseRecord, method: "BITCOIN" })).toThrow();
    expect(() => paymentRecordSchema.parse({ ...baseRecord, invoiceId: "not-a-cuid" })).toThrow();
  });
  it("caps notes at 1000 characters", () => {
    expect(() => paymentRecordSchema.parse({ ...baseRecord, notes: "x".repeat(1001) })).toThrow();
    expect(() => paymentRecordSchema.parse({ ...baseRecord, notes: "x".repeat(1000) })).not.toThrow();
  });
});

describe("read/void/refund/checkout schemas", () => {
  it("accepts only a cuid id and nothing else", () => {
    expect(paymentReadSchema.parse({ id: CUID })).toEqual({ id: CUID });
    expect(() => paymentReadSchema.parse({ id: "nope" })).toThrow();
    expect(() => paymentReadSchema.parse({ id: CUID, status: "VOIDED" })).toThrow();
  });
  it("keeps void/refund payloads to the id only", () => {
    expect(() => ({ id: CUID }) as never).toBeDefined();
  });
  it("limits checkout to the invoice id (amount is the server-known balance)", () => {
    expect(paymentStripeCheckoutSchema.parse({ invoiceId: CUID })).toEqual({ invoiceId: CUID });
    expect(() => paymentStripeCheckoutSchema.parse({ invoiceId: CUID, amountCents: 100 })).toThrow();
  });
  it("bounds pagination and rejects unknown list filters", () => {
    const parsed = paymentListActionSchema.parse({ page: 2, pageSize: 50 });
    expect(parsed.page).toBe(2);
    expect(parsed.pageSize).toBe(50);
    expect(() => paymentListActionSchema.parse({ page: 0 })).toThrow();
    expect(() => paymentListActionSchema.parse({ pageSize: 101 })).toThrow();
    expect(() => paymentListActionSchema.parse({ search: "x" })).toThrow();
    expect(() => paymentListActionSchema.parse({ status: "NOPE" })).toThrow();
  });
});
