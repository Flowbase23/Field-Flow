/** Zod contracts for the estimate domain (src/features/estimates/schemas.ts). */
import { describe, expect, it } from "vitest";
import {
  estimateCreateSchema,
  estimateReadSchema,
  estimateSettableStatusSchema,
  estimateStatusUpdateSchema,
  estimateUpdateActionSchema,
  estimateUpdateSchema,
} from "@/features/estimates/schemas";

const CUID = "cjld93cjlb000000c4bmu1jn";
const validBase = {
  customerId: CUID,
  jobId: null,
  title: null,
  validUntil: null,
  subtotalCents: 0,
  taxCents: 0,
};

describe("estimateCreateSchema", () => {
  it("applies DRAFT-friendly defaults when the form sends only a customer", () => {
    const parsed = estimateCreateSchema.parse({ customerId: CUID });
    expect(parsed).toEqual(validBase);
  });
  it("transforms YYYY-MM-DD strings into UTC-midnight dates", () => {
    const parsed = estimateCreateSchema.parse({ customerId: CUID, validUntil: "2026-11-15" });
    expect(parsed.validUntil).toEqual(new Date("2026-11-15T00:00:00.000Z"));
  });
  it("transforms a blank title into null", () => {
    const parsed = estimateCreateSchema.parse({ customerId: CUID, title: "   " });
    expect(parsed.title).toBeNull();
  });
  it("rejects fractional or negative cents", () => {
    for (const bad of [10.5, -1]) {
      expect(estimateCreateSchema.safeParse({ customerId: CUID, subtotalCents: bad }).success).toBe(false);
    }
  });
  it("rejects malformed dates, bad ids, and unknown keys (strict)", () => {
    expect(estimateCreateSchema.safeParse({ customerId: CUID, validUntil: "11/15/2026" }).success).toBe(false);
    expect(estimateCreateSchema.safeParse({ customerId: "nope" }).success).toBe(false);
    expect(estimateCreateSchema.safeParse({ ...validBase, totalCents: 1 }).success).toBe(false);
  });
});

describe("estimateUpdateActionSchema", () => {
  it("requires the id and the complete editable field set", () => {
    expect(estimateUpdateActionSchema.safeParse({ id: CUID, ...validBase }).success).toBe(true);
    expect(estimateUpdateActionSchema.safeParse({ ...validBase }).success).toBe(false);
  });
  it("keeps status out of the edit payload (lifecycle-only writes)", () => {
    expect(estimateUpdateActionSchema.safeParse({ id: CUID, ...validBase, status: "ACCEPTED" }).success).toBe(false);
  });
  it("estimateUpdateSchema shares the same shape without the id", () => {
    expect(estimateUpdateSchema.safeParse(validBase).success).toBe(true);
  });
});

describe("estimateStatusUpdateSchema", () => {
  it("accepts every persisted status", () => {
    for (const status of ["DRAFT", "SENT", "ACCEPTED", "DECLINED", "VOID"]) {
      expect(estimateStatusUpdateSchema.safeParse({ id: CUID, status }).success).toBe(true);
    }
  });
  it("rejects the derived EXPIRED as a settable target", () => {
    expect(estimateSettableStatusSchema.safeParse("EXPIRED").success).toBe(false);
  });
});

describe("estimateReadSchema", () => {
  it("validates a cuid id", () => {
    expect(estimateReadSchema.safeParse({ id: CUID }).success).toBe(true);
    expect(estimateReadSchema.safeParse({ id: "x" }).success).toBe(false);
  });
});
