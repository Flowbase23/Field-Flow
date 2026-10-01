/** Invoice Zod contracts (src/features/invoices/schemas.ts). */
import { describe, expect, it } from "vitest";
import {
  invoiceCreateSchema,
  invoiceStatusUpdateSchema,
  invoiceUpdateActionSchema,
} from "@/features/invoices/schemas";

const valid = {
  customerId: "cjld93cjlb000000c4bmu1jn",
  jobId: "cjld93cjlb000000c4bmu1jn",
  issuedAt: "2026-10-01",
  dueAt: "2026-10-31",
  subtotalCents: 10000,
  taxCents: 800,
};

describe("invoiceCreateSchema", () => {
  it("accepts a full payload and transforms dates to UTC-midnight Date objects", () => {
    const parsed = invoiceCreateSchema.parse(valid);
    expect(parsed.subtotalCents).toBe(10000);
    expect(parsed.taxCents).toBe(800);
    expect(parsed.issuedAt).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(parsed.dueAt).toEqual(new Date("2026-10-31T00:00:00.000Z"));
    expect(parsed.jobId).toBe("cjld93cjlb000000c4bmu1jn");
  });
  it("defaults to an unpaid DRAFT-able invoice with no links", () => {
    const parsed = invoiceCreateSchema.parse({ customerId: "cjld93cjlb000000c4bmu1jn" });
    expect(parsed.jobId).toBeNull();
    expect(parsed.issuedAt).toBeNull();
    expect(parsed.dueAt).toBeNull();
    expect(parsed.subtotalCents).toBe(0);
    expect(parsed.taxCents).toBe(0);
  });
  it("rejects fractional/negative money and junk dates", () => {
    expect(() => invoiceCreateSchema.parse({ ...valid, subtotalCents: 100.5 })).toThrow(/whole number of cents/);
    expect(() => invoiceCreateSchema.parse({ ...valid, taxCents: -1 })).toThrow();
    expect(() => invoiceCreateSchema.parse({ ...valid, issuedAt: "10/01/2026" })).toThrow(/YYYY-MM-DD/);
  });
  it("rejects unknown keys — totals/balances never come from the browser", () => {
    expect(() => invoiceCreateSchema.parse({ ...valid, totalCents: 99999999 })).toThrow();
    expect(() => invoiceCreateSchema.parse({ ...valid, balanceCents: 99999999 })).toThrow();
    expect(() => invoiceCreateSchema.parse({ ...valid, paidCents: 1 })).toThrow();
    expect(() => invoiceCreateSchema.parse({ ...valid, status: "SENT" })).toThrow();
    expect(() => invoiceCreateSchema.parse({ ...valid, organizationId: "org-b" })).toThrow();
  });
});

describe("invoiceUpdateActionSchema", () => {
  it("requires the id and keeps nulls as explicit clears", () => {
    const parsed = invoiceUpdateActionSchema.parse({
      id: "cjld93cjlb000000c4bmu1jn",
      ...valid,
      jobId: null,
      issuedAt: null,
      dueAt: null,
    });
    expect(parsed.jobId).toBeNull();
    expect(parsed.dueAt).toBeNull();
    expect(parsed.dueAt).not.toBeUndefined();
  });
  it("rejects protected writes (status/paid/invoice-number)", () => {
    expect(() => invoiceUpdateActionSchema.parse({ id: "cjld93cjlb000000c4bmu1jn", ...valid, status: "PAID" })).toThrow();
    expect(() => invoiceUpdateActionSchema.parse({ id: "cjld93cjlb000000c4bmu1jn", ...valid, paidCents: 100 })).toThrow();
    expect(() => invoiceUpdateActionSchema.parse({ id: "cjld93cjlb000000c4bmu1jn", ...valid, invoiceNumber: 7 })).toThrow();
  });
  it("rejects a missing or malformed id", () => {
    expect(() => invoiceUpdateActionSchema.parse({ ...valid })).toThrow();
    expect(() => invoiceUpdateActionSchema.parse({ id: "not-a-cuid", ...valid })).toThrow();
  });
});

describe("invoiceStatusUpdateSchema", () => {
  it("accepts every settable status", () => {
    for (const status of ["DRAFT", "SENT", "PARTIALLY_PAID", "PAID", "VOID"] as const) {
      expect(invoiceStatusUpdateSchema.parse({ id: "cjld93cjlb000000c4bmu1jn", status }).status).toBe(status);
    }
  });
  it("rejects OVERDUE — it is derived on read and never settable", () => {
    expect(() => invoiceStatusUpdateSchema.parse({ id: "cjld93cjlb000000c4bmu1jn", status: "OVERDUE" })).toThrow();
  });
  it("rejects unknown or missing fields", () => {
    expect(() => invoiceStatusUpdateSchema.parse({ id: "cjld93cjlb000000c4bmu1jn" })).toThrow();
    expect(() => invoiceStatusUpdateSchema.parse({ id: "cjld93cjlb000000c4bmu1jn", status: "NOPE" })).toThrow();
  });
});
