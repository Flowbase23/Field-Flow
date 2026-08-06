/**
 * Customer server actions (Phase 1, Slice 3) — create, edit, activate/deactivate.
 *
 * Every action follows the repo conventions:
 *   1. starts with requirePermission(...) (defense in depth — the UI also
 *      gates controls via can()/RequirePermission),
 *   2. validates input with a Zod schema (features/customers/schemas.ts),
 *   3. reaches the Customer model ONLY through the tenant-scoped customer repo
 *      (createCustomerRepo injects the organizationId predicate; cross-tenant
 *      ids are indistinguishable from missing rows → NotFoundError),
 *   4. enforces the DUPLICATE POLICY (features/customers/duplicates.ts): an
 *      existing ACTIVE customer in the same org with the same email/phone
 *      blocks create (and update, when email/phone change) with a 409
 *      ConflictError that tells the operator to link instead,
 *   5. writes an append-only AuditLog entry in the SAME transaction (withAudit),
 *   6. returns ActionResult so the client can surface typed errors.
 *
 * PENDING LIVE VERIFICATION: requirePermission() depends on a real Clerk
 * session (auth() → orgId), so these cannot be exercised until Clerk keys +
 * a provisioned org exist. The DB writes behind them are untested against the
 * live database until the verification pass.
 */
"use server";

import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/require-org";
import { createCustomerRepo } from "@/server/repositories/customer.repo";
import { db } from "@/server/db/client";
import { withAudit } from "@/server/audit";
import { ConflictError, NotFoundError, actionError, type ActionResult } from "@/lib/errors";
import {
  customerCreateSchema,
  customerSetActiveSchema,
  customerUpdateActionSchema,
  type CustomerCreateInput,
  type CustomerUpdateActionInput,
} from "../schemas";
import {
  duplicateErrorMessage,
  findDuplicateCustomer,
} from "../duplicates";

export interface CustomerActionResult {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

function snapshot(data: {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  type: string;
  notes: string | null;
  isActive: boolean;
}): Record<string, unknown> {
  return {
    firstName: data.firstName,
    lastName: data.lastName,
    companyName: data.companyName,
    email: data.email,
    phone: data.phone,
    type: data.type,
    notes: data.notes,
    isActive: data.isActive,
  };
}

/**
 * Create a customer.
 * Guards: CUSTOMER_CREATE, Zod schema, duplicate policy (email/phone, active
 * customers only), tenant-scoped write. Audited (CREATE).
 */
export async function createCustomer(input: unknown): Promise<ActionResult<CustomerActionResult>> {
  try {
    const ctx = await requirePermission(Permission.CUSTOMER_CREATE);
    const data: CustomerCreateInput = customerCreateSchema.parse(input);

    const repo = createCustomerRepo(db, ctx.organizationId);
    const candidates = await repo.findByEmailOrPhone(data.email, data.phone);
    const duplicate = findDuplicateCustomer(candidates, { email: data.email, phone: data.phone });
    if (duplicate) {
      throw new ConflictError(duplicateErrorMessage(duplicate));
    }

    const created = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.CREATE,
        entityType: "Customer",
        entityId: undefined,
        before: null,
        after: createdPlaceholder(data),
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createCustomerRepo(tx, ctx.organizationId).create(data),
    );

    revalidatePath(`/${ctx.organization.slug}/customers`);
    return {
      ok: true,
      data: { id: created.id, firstName: created.firstName, lastName: created.lastName, companyName: created.companyName },
    };
  } catch (err) {
    return actionError(err);
  }
}

/** @internal — the snapshot needs the data BEFORE the DB write; keep in one place. */
function createdPlaceholder(data: CustomerCreateInput) {
  return {
    firstName: data.firstName ?? null,
    lastName: data.lastName ?? null,
    companyName: data.companyName ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    type: data.type,
    notes: data.notes ?? null,
    isActive: true,
  };
}

/**
 * Update a customer (name fields, email/phone, type, notes).
 * Guards: CUSTOMER_UPDATE, Zod schema, tenant-scoped target (NotFoundError
 * off-tenant), duplicate policy excluding the record itself. Audited (UPDATE,
 * before/after snapshots).
 */
export async function updateCustomer(input: unknown): Promise<ActionResult<CustomerActionResult>> {
  try {
    const ctx = await requirePermission(Permission.CUSTOMER_UPDATE);
    const { id, ...data }: CustomerUpdateActionInput = customerUpdateActionSchema.parse(input);

    const repo = createCustomerRepo(db, ctx.organizationId);
    const existing = await repo.getById(id);
    if (!existing) {
      throw new NotFoundError("Customer not found in this organization.");
    }

    // Duplicate policy: only re-check when email/phone actually change.
    const emailChanged = (data.email ?? null) !== existing.email;
    const phoneChanged = (data.phone ?? null) !== existing.phone;
    if (emailChanged || phoneChanged) {
      const candidates = await repo.findByEmailOrPhone(data.email ?? existing.email, data.phone ?? existing.phone);
      const duplicate = findDuplicateCustomer(candidates, {
        email: data.email ?? existing.email,
        phone: data.phone ?? existing.phone,
        excludeId: existing.id,
      });
      if (duplicate) {
        throw new ConflictError(duplicateErrorMessage(duplicate));
      }
    }

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.UPDATE,
        entityType: "Customer",
        entityId: id,
        before: snapshot(existing),
        after: snapshot({ ...existing, ...data }),
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createCustomerRepo(tx, ctx.organizationId).update(id, data),
    );

    revalidatePath(`/${ctx.organization.slug}/customers`);
    revalidatePath(`/${ctx.organization.slug}/customers/${id}`);
    return {
      ok: true,
      data: { id: updated.id, firstName: updated.firstName, lastName: updated.lastName, companyName: updated.companyName },
    };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Activate/deactivate a customer (soft delete — records are never hard-deleted).
 * Deactivating requires CUSTOMER_DELETE; reactivating requires CUSTOMER_UPDATE.
 * Audited (STATUS_CHANGED, before/after).
 */
export async function setCustomerActive(input: unknown): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  try {
    const parsed = customerSetActiveSchema.parse(input);
    // Gate differs by direction: destroying access to a record needs DELETE;
    // restoring it needs UPDATE.
    const ctx = await requirePermission(parsed.isActive ? Permission.CUSTOMER_UPDATE : Permission.CUSTOMER_DELETE);

    const repo = createCustomerRepo(db, ctx.organizationId);
    const existing = await repo.getById(parsed.id);
    if (!existing) {
      throw new NotFoundError("Customer not found in this organization.");
    }
    if (existing.isActive === parsed.isActive) {
      return { ok: true, data: { id: existing.id, isActive: existing.isActive } }; // no-op
    }

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.STATUS_CHANGED,
        entityType: "Customer",
        entityId: parsed.id,
        before: { isActive: existing.isActive },
        after: { isActive: parsed.isActive },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) =>
        parsed.isActive
          ? createCustomerRepo(tx, ctx.organizationId).setActive(parsed.id, true)
          : createCustomerRepo(tx, ctx.organizationId).remove(parsed.id),
    );

    revalidatePath(`/${ctx.organization.slug}/customers`);
    revalidatePath(`/${ctx.organization.slug}/customers/${parsed.id}`);
    return { ok: true, data: { id: updated.id, isActive: updated.isActive } };
  } catch (err) {
    return actionError(err);
  }
}
