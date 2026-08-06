/**
 * Lead server actions (Phase 1, Slice 3) — create, full edit, status changes
 * (server-enforced pipeline), customer association, and WON conversion.
 *
 * Conventions (as customer.actions.ts): requirePermission → Zod → tenant-scoped
 * repo → audit in the same transaction → ActionResult.
 *
 * Pipeline enforcement (design §3 "server-enforced"): every status change goes
 * through applyLeadTransition (src/server/domain/lead-pipeline.ts) — the
 * allowed-transition map + LOST-requires-reason rule are enforced HERE, not in
 * the UI. Same-status updates are no-ops (nothing to audit).
 *
 * Tenant safety: Lead.customer is an id-only FK per the Slice 1 deviation
 * (optional tenant links can't carry the compound constraint), so the
 * org-scope of ANY customerId/ownerUserId input is verified in this layer via
 * the tenant-scoped customer/membership repos — cross-tenant ids → NotFoundError.
 *
 * PENDING LIVE VERIFICATION: requirePermission() needs a real Clerk session;
 * DB writes are untested until the verification pass.
 */
"use server";

import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/require-org";
import { createCustomerRepo } from "@/server/repositories/customer.repo";
import { createLeadRepo } from "@/server/repositories/lead.repo";
import { createMembershipRepo } from "@/server/repositories/membership.repo";
import { db } from "@/server/db/client";
import { withAudit, writeAuditLog } from "@/server/audit";
import {
  ConflictError,
  NotFoundError,
  actionError,
  type ActionResult,
} from "@/lib/errors";
import { applyLeadTransition } from "@/server/domain/lead-pipeline";
import {
  leadAttachCustomerSchema,
  leadConvertSchema,
  leadCreateSchema,
  leadStatusUpdateSchema,
  leadUpdateActionSchema,
  type LeadCreateInput,
  type LeadUpdateActionInput,
} from "../schemas";
import {
  duplicateErrorMessage,
  findDuplicateCustomer,
} from "@/features/customers/duplicates";

export interface LeadActionResult {
  id: string;
  title: string;
  status: string;
  customerId: string | null;
}

/** @internal — undefined allowed so snapshots can be built by spreading partial input. */
function leadSnapshot(lead: {
  title: string;
  description: string | null | undefined;
  source: string;
  status: string;
  estimatedValueCents: number | null | undefined;
  ownerUserId: string | null | undefined;
  customerId: string | null | undefined;
}): Record<string, unknown> {
  return {
    title: lead.title,
    description: lead.description ?? null,
    source: lead.source,
    status: lead.status,
    estimatedValueCents: lead.estimatedValueCents ?? null,
    ownerUserId: lead.ownerUserId ?? null,
    customerId: lead.customerId ?? null,
  };
}

/**
 * Verify a prospective ownerUserId is an ACTIVE member of the org. Lead has no
 * Prisma relation to User, so the membership repo (tenant-scoped) is the check.
 */
async function assertOwnerInOrg(organizationId: string, ownerUserId: string | null | undefined): Promise<void> {
  if (!ownerUserId) return;
  const membership = await createMembershipRepo(db, organizationId).getByUserId(ownerUserId);
  if (!membership?.isActive) {
    throw new NotFoundError("The assigned owner is not an active member of this organization.");
  }
}

/**
 * Verify a prospective customerId belongs to the org (Lead.customer is an
 * id-only FK — this is the tenant-scope backstop for the link).
 */
async function assertCustomerInOrg(organizationId: string, customerId: string | null | undefined): Promise<void> {
  if (!customerId) return;
  const customer = await createCustomerRepo(db, organizationId).getById(customerId);
  if (!customer) {
    throw new NotFoundError("Customer not found in this organization.");
  }
}

/**
 * Create a lead. Guards: LEAD_CREATE, Zod schema, owner/customer must belong to
 * the org, tenant-scoped write. Audited (CREATE).
 */
export async function createLead(input: unknown): Promise<ActionResult<LeadActionResult>> {
  try {
    const ctx = await requirePermission(Permission.LEAD_CREATE);
    const data: LeadCreateInput = leadCreateSchema.parse(input);

    await assertOwnerInOrg(ctx.organizationId, data.ownerUserId);
    await assertCustomerInOrg(ctx.organizationId, data.customerId);

    const created = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.CREATE,
        entityType: "Lead",
        entityId: undefined,
        before: null,
        after: leadSnapshot({
          title: data.title,
          description: data.description ?? null,
          source: data.source,
          status: data.status ?? "NEW",
          estimatedValueCents: data.estimatedValueCents ?? null,
          ownerUserId: data.ownerUserId ?? null,
          customerId: data.customerId ?? null,
        }),
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createLeadRepo(tx, ctx.organizationId).create(data),
    );

    revalidatePath(`/${ctx.organization.slug}/leads`);
    return {
      ok: true,
      data: { id: created.id, title: created.title, status: created.status, customerId: created.customerId },
    };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Full lead edit. Guards: LEAD_UPDATE, Zod schema, tenant-scoped target
 * (NotFoundError off-tenant), owner/customer scoping when provided. Audited
 * (UPDATE, before/after).
 */
export async function updateLead(input: unknown): Promise<ActionResult<LeadActionResult>> {
  try {
    const ctx = await requirePermission(Permission.LEAD_UPDATE);
    const { id, ...data }: LeadUpdateActionInput = leadUpdateActionSchema.parse(input);

    const repo = createLeadRepo(db, ctx.organizationId);
    const existing = await repo.getById(id);
    if (!existing) {
      throw new NotFoundError("Lead not found in this organization.");
    }

    if (data.ownerUserId !== undefined) await assertOwnerInOrg(ctx.organizationId, data.ownerUserId);
    if (data.customerId !== undefined) await assertCustomerInOrg(ctx.organizationId, data.customerId);

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.UPDATE,
        entityType: "Lead",
        entityId: id,
        before: leadSnapshot(existing),
        after: leadSnapshot({ ...existing, ...data }),
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createLeadRepo(tx, ctx.organizationId).update(id, data),
    );

    revalidatePath(`/${ctx.organization.slug}/leads`);
    revalidatePath(`/${ctx.organization.slug}/leads/${id}`);
    return {
      ok: true,
      data: { id: updated.id, title: updated.title, status: updated.status, customerId: updated.customerId },
    };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Change a lead's status through the pipeline.
 *
 * Guards: LEAD_UPDATE, Zod schema (LOST → lostReason super-refined), tenant
 * target, and — the core rule — the transition map in applyLeadTransition:
 * only NEW→CONTACTED→QUALIFIED→ESTIMATE→WON (any → LOST with a reason) is
 * allowed; WON/LOST are terminal; illegal transitions → ConflictError.
 * Same-status → no-op. Audited (STATUS_CHANGED, before/after incl. timestamps).
 */
export async function updateLeadStatus(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const ctx = await requirePermission(Permission.LEAD_UPDATE);
    const { id, status, lostReason } = leadStatusUpdateSchema.parse(input);

    const repo = createLeadRepo(db, ctx.organizationId);
    const existing = await repo.getById(id);
    if (!existing) {
      throw new NotFoundError("Lead not found in this organization.");
    }

    const fields = applyLeadTransition(existing.status, status, { lostReason });
    if (Object.keys(fields).length === 0) {
      return { ok: true, data: { id, status } }; // same-status no-op — nothing to audit
    }

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.STATUS_CHANGED,
        entityType: "Lead",
        entityId: id,
        before: { status: existing.status },
        after: { status, ...fields },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createLeadRepo(tx, ctx.organizationId).updateStatus(id, { status, ...fields }),
    );

    revalidatePath(`/${ctx.organization.slug}/leads`);
    revalidatePath(`/${ctx.organization.slug}/leads/${id}`);
    return { ok: true, data: { id, status: updated.status } };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Attach an existing customer to a lead.
 * Guards: LEAD_UPDATE, Zod schema, customer must belong to the org
 * (cross-tenant customerId → NotFoundError). No-op when already linked.
 * Audited (UPDATE, before/after customerId).
 */
export async function attachCustomerToLead(input: unknown): Promise<ActionResult<{ id: string; customerId: string }>> {
  try {
    const ctx = await requirePermission(Permission.LEAD_UPDATE);
    const { id, customerId } = leadAttachCustomerSchema.parse(input);

    const repo = createLeadRepo(db, ctx.organizationId);
    const existing = await repo.getById(id);
    if (!existing) {
      throw new NotFoundError("Lead not found in this organization.");
    }
    await assertCustomerInOrg(ctx.organizationId, customerId);
    if (existing.customerId === customerId) {
      return { ok: true, data: { id, customerId } }; // no-op
    }

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.UPDATE,
        entityType: "Lead",
        entityId: id,
        before: { customerId: existing.customerId },
        after: { customerId },
        metadata: { operation: "attach-customer" },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createLeadRepo(tx, ctx.organizationId).update(id, { customerId }),
    );

    revalidatePath(`/${ctx.organization.slug}/leads/${id}`);
    revalidatePath(`/${ctx.organization.slug}/customers/${customerId}`);
    return { ok: true, data: { id, customerId: updated.customerId ?? customerId } };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Convert a WON lead into a customer (minimal per the slice brief): creates a
 * Customer when the lead has none linked, links lead.customerId, audits — the
 * "first job placeholder" is intentionally deferred to Slice 5 (job creation
 * needs a location + org-local jobNumber allocation, which live in that slice).
 *
 * Guards: LEAD_UPDATE; lead must exist in the org and be WON; the duplicate
 * policy applies to any email/phone supplied with the conversion (409 → link
 * instead). All writes + audit rows happen in ONE transaction.
 */
export async function convertWonLead(input: unknown): Promise<ActionResult<{ leadId: string; customerId: string }>> {
  try {
    const ctx = await requirePermission(Permission.LEAD_UPDATE);
    const { id, customer: customerInput } = leadConvertSchema.parse(input);

    const leadRepo = createLeadRepo(db, ctx.organizationId);
    const lead = await leadRepo.getById(id);
    if (!lead) {
      throw new NotFoundError("Lead not found in this organization.");
    }
    if (lead.status !== "WON") {
      throw new ConflictError(`Only won leads can be converted to customers (this lead is ${lead.status}).`);
    }
    if (lead.customerId) {
      return { ok: true, data: { leadId: id, customerId: lead.customerId } }; // already converted
    }

    // Derive the customer record from the lead (minimal conversion).
    const titleParts = lead.title.trim().split(/\s+/);
    const customerData = {
      firstName: customerInput?.firstName ?? null,
      lastName: customerInput?.lastName ?? null,
      companyName: customerInput?.companyName ?? null,
      email: customerInput?.email ?? null,
      phone: customerInput?.phone ?? null,
      type: customerInput?.type ?? "RESIDENTIAL",
      notes: customerInput?.notes ?? null,
    };
    if (!customerData.firstName && !customerData.lastName && !customerData.companyName) {
      if (titleParts.length >= 2) {
        customerData.firstName = titleParts[0];
        customerData.lastName = titleParts.slice(1).join(" ");
      } else {
        customerData.companyName = lead.title;
      }
    }

    // Duplicate policy applies to conversion too.
    const customerRepo = createCustomerRepo(db, ctx.organizationId);
    const candidates = await customerRepo.findByEmailOrPhone(customerData.email, customerData.phone);
    const duplicate = findDuplicateCustomer(candidates, { email: customerData.email, phone: customerData.phone });
    if (duplicate) {
      throw new ConflictError(`${duplicateErrorMessage(duplicate)} Attach the lead to that customer instead.`);
    }

    const result = await db.$transaction(async (tx) => {
      const created = await createCustomerRepo(tx, ctx.organizationId).create(customerData);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.CREATE,
          entityType: "Customer",
          entityId: created.id,
          before: null,
          after: { ...customerData, id: created.id },
          metadata: { convertedFromLeadId: lead.id, leadTitle: lead.title },
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      const updated = await createLeadRepo(tx, ctx.organizationId).update(lead.id, { customerId: created.id });
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.UPDATE,
          entityType: "Lead",
          entityId: lead.id,
          before: { customerId: null },
          after: { customerId: created.id },
          metadata: { operation: "convert-won-lead", createdCustomerId: created.id },
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      return { customer: created, lead: updated };
    });

    revalidatePath(`/${ctx.organization.slug}/leads`);
    revalidatePath(`/${ctx.organization.slug}/leads/${lead.id}`);
    revalidatePath(`/${ctx.organization.slug}/customers`);
    revalidatePath(`/${ctx.organization.slug}/customers/${result.customer.id}`);
    return { ok: true, data: { leadId: lead.id, customerId: result.customer.id } };
  } catch (err) {
    return actionError(err);
  }
}
