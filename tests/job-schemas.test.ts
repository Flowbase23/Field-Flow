import { describe, expect, it } from "vitest";
import { jobCreateSchema, jobStatusUpdateSchema, jobUpdateActionSchema } from "@/features/jobs/schemas";

const VALID_CUID = "clx1234567890abcdefghijkl";

describe("job schemas", () => {
  const minimum = { title: "Replace condenser", type: "SERVICE_CALL", customerId: VALID_CUID, locationId: VALID_CUID };

  it("validates core job fields and applies only create defaults", () => {
    const parsed = jobCreateSchema.parse(minimum);
    expect(parsed.priority).toBe("NORMAL");
    expect(parsed.leadId).toBeNull();
    expect(parsed.description).toBeNull();
    expect(parsed.subtotalCents).toBe(0);
    expect(parsed.taxCents).toBe(0);
    expect(parsed.totalCents).toBe(0);
    expect(parsed.actualRevenueCents).toBeNull();
  });

  it("accepts all valid enum values and integer-cent money fields", () => {
    for (const type of ["SERVICE_CALL", "INSTALLATION", "INSPECTION", "MAINTENANCE", "EMERGENCY", "WARRANTY"]) {
      expect(jobCreateSchema.safeParse({ ...minimum, type }).success).toBe(true);
    }
    for (const priority of ["LOW", "NORMAL", "HIGH", "URGENT"]) {
      expect(jobCreateSchema.safeParse({ ...minimum, priority }).success).toBe(true);
    }
    const parsed = jobCreateSchema.parse({ ...minimum, quotedAmountCents: 12500, subtotalCents: 10000, taxCents: 800, totalCents: 10800, actualRevenueCents: 10500 });
    expect(parsed.totalCents).toBe(10800);
  });

  it("rejects bad lifecycle/browser tenant input and invalid money", () => {
    expect(jobCreateSchema.safeParse({ ...minimum, status: "SCHEDULED" }).success).toBe(false);
    expect(jobCreateSchema.safeParse({ ...minimum, organizationId: VALID_CUID }).success).toBe(false);
    expect(jobCreateSchema.safeParse({ ...minimum, quotedAmountCents: 1.5 }).success).toBe(false);
    expect(jobCreateSchema.safeParse({ ...minimum, subtotalCents: -1 }).success).toBe(false);
    expect(jobCreateSchema.safeParse({ ...minimum, totalCents: 10.1 }).success).toBe(false);
    expect(jobCreateSchema.safeParse({ ...minimum, type: "PROJECT" }).success).toBe(false);
  });

  it("keeps edit partial and lifecycle transitions separate", () => {
    const parsed = jobUpdateActionSchema.parse({ id: VALID_CUID, description: "  Call on arrival  " });
    expect(parsed.description).toBe("Call on arrival");
    expect("priority" in parsed).toBe(false);
    expect(jobUpdateActionSchema.safeParse({ id: VALID_CUID, status: "SCHEDULED" }).success).toBe(false);
    expect(jobStatusUpdateSchema.safeParse({ id: VALID_CUID, status: "IN_PROGRESS" }).success).toBe(true);
    expect(jobStatusUpdateSchema.safeParse({ id: VALID_CUID, status: "ARCHIVED" }).success).toBe(false);
  });
});
