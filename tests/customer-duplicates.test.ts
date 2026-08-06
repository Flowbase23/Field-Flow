/**
 * Pure-logic tests for the customer duplicate policy
 * (src/features/customers/duplicates.ts): an active customer with the same
 * email (case-insensitive) or phone blocks creation; inactive customers and
 * the record being edited do not.
 */
import { describe, expect, it } from "vitest";
import type { Customer } from "@prisma/client";
import {
  customerDisplayName,
  duplicateErrorMessage,
  findDuplicateCustomer,
} from "@/features/customers/duplicates";

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "clx1234567890abcdefghijkl",
    organizationId: "org-1",
    firstName: "Jane",
    lastName: "Doe",
    companyName: null,
    email: null,
    phone: null,
    type: "RESIDENTIAL",
    notes: null,
    isActive: true,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

const jane = makeCustomer({ id: "cust-1", firstName: "Jane", lastName: "Doe", email: "jane@acme.com", phone: "(555) 111-2222" });
const bob = makeCustomer({ id: "cust-2", firstName: "Bob", lastName: "Smith", companyName: "Bob's Repair", email: "bob@acme.com", phone: "(555) 333-4444" });

describe("findDuplicateCustomer", () => {
  it("finds a duplicate by email (case-insensitive)", () => {
    expect(findDuplicateCustomer([jane, bob], { email: "JANE@ACME.COM" })?.id).toBe("cust-1");
    expect(findDuplicateCustomer([jane, bob], { email: "jane@acme.com" })?.id).toBe("cust-1");
  });

  it("finds a duplicate by phone", () => {
    expect(findDuplicateCustomer([jane, bob], { phone: "(555) 111-2222" })?.id).toBe("cust-1");
  });

  it("matches either email or phone", () => {
    expect(findDuplicateCustomer([jane, bob], { email: "bob@acme.com", phone: "(555) 111-2222" })?.id).toBe("cust-1");
  });

  it("returns null when nothing matches", () => {
    expect(findDuplicateCustomer([jane, bob], { email: "nobody@acme.com", phone: "(555) 999-0000" })).toBeNull();
    expect(findDuplicateCustomer([jane, bob], {})).toBeNull();
  });

  it("returns null when the only match is the record being edited", () => {
    expect(findDuplicateCustomer([jane, bob], { email: "jane@acme.com", excludeId: "cust-1" })).toBeNull();
  });

  it("returns null when input email/phone are empty", () => {
    expect(findDuplicateCustomer([jane, bob], { email: "", phone: "  " })).toBeNull();
  });
});

describe("duplicate messaging", () => {
  it("formats a helpful link-instead error", () => {
    const msg = duplicateErrorMessage(jane);
    expect(msg).toContain("Jane Doe");
    expect(msg).toContain("jane@acme.com");
    expect(msg).toContain("link");
  });

  it("falls back to company name when there is no personal name", () => {
    const corp = makeCustomer({ firstName: null, lastName: null, companyName: "Acme Co", email: "x@acme.com" });
    expect(customerDisplayName(corp)).toBe("Acme Co");
    expect(duplicateErrorMessage(corp)).toContain("Acme Co");
  });
});
