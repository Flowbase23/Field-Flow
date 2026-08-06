/**
 * Customer duplicate detection — PURE logic (no DB, no server-only imports),
 * unit-tested in tests/customer-duplicates.test.ts.
 *
 * Duplicate policy (README "Slice 3 — CRM"): on CREATE (and on UPDATE that
 * changes email/phone), an existing ACTIVE customer in the SAME organization
 * with the same email (case-insensitive) or phone blocks the write with a
 * 409 ConflictError telling the operator to link to the existing record
 * instead of creating a duplicate. Inactive (soft-deleted) customers do NOT
 * block — their records are intentionally reusable.
 *
 * The repository (customer.repo.ts findByEmailOrPhone) does the tenant-scoped
 * query; this helper picks the offending record out of the candidates and
 * formats the error message. Keeping the decision here makes the policy
 * testable without a database.
 */
import type { Customer } from "@prisma/client";

export interface DuplicateCheckInput {
  /** Trimmed email from validated input (may be null). */
  email?: string | null;
  /** Trimmed phone from validated input (may be null). */
  phone?: string | null;
  /** When updating, exclude the record being edited so self-matches don't block. */
  excludeId?: string;
}

export function normalizeForCompare(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Returns the first ACTIVE customer among `candidates` that matches `input` by
 * email (case-insensitive) or phone (exact). `excludeId` is skipped.
 * The caller must pass only tenant-scoped, active candidates.
 */
export function findDuplicateCustomer(
  candidates: readonly Customer[],
  input: DuplicateCheckInput,
): Customer | null {
  const email = normalizeForCompare(input.email);
  const phone = normalizeForCompare(input.phone);
  for (const candidate of candidates) {
    if (input.excludeId && candidate.id === input.excludeId) continue;
    const candidateEmail = normalizeForCompare(candidate.email);
    const candidatePhone = normalizeForCompare(candidate.phone);
    if (email && candidateEmail && candidateEmail === email) return candidate;
    if (phone && candidatePhone && candidatePhone === phone) return candidate;
  }
  return null;
}

/** Human-readable customer label for error messages ("Jane Smith" / "Acme Co" / "customer"). */
export function customerDisplayName(customer: Pick<Customer, "firstName" | "lastName" | "companyName">): string {
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim();
  return name || customer.companyName || "existing customer";
}

/**
 * The clear error message the duplicate policy promises: tell the operator WHAT
 * matched and that they should LINK to the existing record instead.
 */
export function duplicateErrorMessage(customer: Customer): string {
  const matched: string[] = [];
  if (customer.email) matched.push(`email ${customer.email}`);
  if (customer.phone) matched.push(`phone ${customer.phone}`);
  const detail = matched.length > 0 ? ` (${matched.join(", ")})` : "";
  return (
    `A customer "${customerDisplayName(customer)}" already exists${detail}. ` +
    `Open that customer and link this record to it instead of creating a duplicate.`
  );
}
