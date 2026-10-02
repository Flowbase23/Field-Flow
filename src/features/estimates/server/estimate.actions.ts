/**
 * Estimate server actions — Phase 2 Slice P2-2. Organization identity comes
 * solely from Clerk-backed requirePermission(); the browser payloads have no
 * organizationId field. Each mutation and its audit row share one database
 * transaction, and Estimates are reached only through the tenant-scoped repo.
 */
"use server";
import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { actionError, ForbiddenError, NotFoundError, type ActionResult } from "@/lib/errors";
import { toAuditJson, writeAuditLog } from "@/server/audit";
import { hasPermission } from "@/server/auth/permissions";
import { requirePermission } from "@/server/auth/require-org";
import { db } from "@/server/db/client";
import { createJobRepo } from "@/server/repositories/job.repo";
import { createEstimateRepo } from "@/server/repositories/estimate.repo";
import {
  estimateConvertSchema,
  estimateCreateSchema,
  estimateReadSchema,
  estimateStatusUpdateSchema,
  estimateUpdateActionSchema,
} from "../schemas";

export interface EstimateActionResult {
  id: string;
  estimateNumber: number;
  status: string;
  totalCents: number;
}
interface EstimateSnapshotFields {
  estimateNumber?: number;
  customerId: string;
  jobId: string | null;
  status: string;
  title: string | null;
  validUntil: Date | null;
  sentAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}
function estimateSnapshot(estimate: EstimateSnapshotFields) {
  return {
    estimateNumber: estimate.estimateNumber,
    customerId: estimate.customerId,
    jobId: estimate.jobId,
    status: estimate.status,
    title: estimate.title,
    validUntil: estimate.validUntil?.toISOString() ?? null,
    sentAt: estimate.sentAt?.toISOString() ?? null,
    acceptedAt: estimate.acceptedAt?.toISOString() ?? null,
    declinedAt: estimate.declinedAt?.toISOString() ?? null,
    subtotalCents: estimate.subtotalCents,
    taxCents: estimate.taxCents,
    totalCents: estimate.totalCents,
  };
}
function revalidateEstimates(orgSlug: string, estimateId?: string): void {
  revalidatePath(`/${orgSlug}/estimates`);
  if (estimateId) revalidatePath(`/${orgSlug}/estimates/${estimateId}`);
}
/** Tenant-scoped read primitive. ESTIMATE_READ is enforced independently of any UI. */
export async function getEstimate(input: unknown): Promise<ActionResult<EstimateActionResult>> {
  try {
    const ctx = await requirePermission(Permission.ESTIMATE_READ);
    const { id } = estimateReadSchema.parse(input);
    const estimate = await createEstimateRepo(db, ctx.organizationId).getById(id);
    if (!estimate) throw new NotFoundError("Estimate not found in this organization.");
    return {
      ok: true,
      data: {
        id: estimate.id,
        estimateNumber: estimate.estimateNumber,
        status: estimate.status,
        totalCents: estimate.totalCents,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}
/** Create in DRAFT with an atomic org-local estimate number and CREATE audit record. */
export async function createEstimate(input: unknown): Promise<ActionResult<EstimateActionResult>> {
  try {
    const ctx = await requirePermission(Permission.ESTIMATE_CREATE);
    const data = estimateCreateSchema.parse(input);
    const created = await db.$transaction(async (tx) => {
      const estimate = await createEstimateRepo(tx, ctx.organizationId).create(data);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.CREATE,
          entityType: "Estimate",
          entityId: estimate.id,
          before: toAuditJson(null),
          after: toAuditJson(estimateSnapshot(estimate)),
          metadata: toAuditJson({
            requested: {
              customerId: data.customerId,
              jobId: data.jobId,
              title: data.title,
              validUntil: data.validUntil?.toISOString() ?? null,
              subtotalCents: data.subtotalCents,
              taxCents: data.taxCents,
            },
          }),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      return estimate;
    });
    revalidateEstimates(ctx.organization.slug, created.id);
    return {
      ok: true,
      data: {
        id: created.id,
        estimateNumber: created.estimateNumber,
        status: created.status,
        totalCents: created.totalCents,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}
/** Edit customer/job/title/valid-until/subtotal/tax; the repo recomputes the total server-side. */
export async function updateEstimate(input: unknown): Promise<ActionResult<EstimateActionResult>> {
  try {
    const ctx = await requirePermission(Permission.ESTIMATE_UPDATE);
    const { id, ...data } = estimateUpdateActionSchema.parse(input);
    const updated = await db.$transaction(async (tx) => {
      const repo = createEstimateRepo(tx, ctx.organizationId);
      const existing = await repo.getById(id);
      if (!existing) throw new NotFoundError("Estimate not found in this organization.");
      const updated = await repo.update(id, data);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.UPDATE,
          entityType: "Estimate",
          entityId: id,
          before: toAuditJson(estimateSnapshot(existing)),
          after: toAuditJson(estimateSnapshot(updated)),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      return updated;
    });
    revalidateEstimates(ctx.organization.slug, updated.id);
    return {
      ok: true,
      data: {
        id: updated.id,
        estimateNumber: updated.estimateNumber,
        status: updated.status,
        totalCents: updated.totalCents,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}
/** Server-enforced lifecycle transition; only this action writes Estimate.status. */
export async function setEstimateStatus(input: unknown): Promise<ActionResult<EstimateActionResult>> {
  try {
    const ctx = await requirePermission(Permission.ESTIMATE_STATUS_UPDATE);
    const { id, status } = estimateStatusUpdateSchema.parse(input);
    const result = await db.$transaction(async (tx) => {
      const repo = createEstimateRepo(tx, ctx.organizationId);
      const existing = await repo.getById(id);
      if (!existing) throw new NotFoundError("Estimate not found in this organization.");
      const updated = await repo.setStatus(id, status);
      const changed = updated.status !== existing.status;
      if (changed) {
        await writeAuditLog(
          {
            organizationId: ctx.organizationId,
            action: AuditAction.STATUS_CHANGED,
            entityType: "Estimate",
            entityId: id,
            before: toAuditJson(estimateSnapshot(existing)),
            after: toAuditJson(estimateSnapshot(updated)),
            actorUserId: ctx.userId,
            actorClerkUserId: ctx.clerkUserId,
          },
          tx,
        );
      }
      return { changed, estimate: updated };
    });
    if (result.changed) revalidateEstimates(ctx.organization.slug, result.estimate.id);
    return {
      ok: true,
      data: {
        id: result.estimate.id,
        estimateNumber: result.estimate.estimateNumber,
        status: result.estimate.status,
        totalCents: result.estimate.totalCents,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

/** Result payload for the estimate → job conversion (the UI links to the job). */
export interface ConvertEstimateToJobResult {
  estimateId: string;
  jobId: string;
  jobNumber: number;
  jobTitle: string;
}

/**
 * Audit snapshot of the job a conversion created. Mirrors the shape of the
 * job feature's create snapshot (job.actions.ts keeps its helper private —
 * "use server" modules can only export async server functions), so the audit
 * trail of a converted job reads like any other job-creation entry.
 */
function convertedJobSnapshot(job: {
  jobNumber: number;
  customerId: string;
  locationId: string | null;
  type: string;
  priority: string;
  status: string;
  title: string;
  description: string | null;
  quotedAmountCents: number | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}) {
  return {
    jobNumber: job.jobNumber,
    customerId: job.customerId,
    locationId: job.locationId,
    type: job.type,
    priority: job.priority,
    status: job.status,
    title: job.title,
    description: job.description,
    quotedAmountCents: job.quotedAmountCents,
    subtotalCents: job.subtotalCents,
    taxCents: job.taxCents,
    totalCents: job.totalCents,
  };
}

/**
 * Converts an ACCEPTED estimate into a new Job (Phase 2 Slice P2-2 follow-up).
 *
 * Permission gate: JOB_CREATE is the primary gate — the observable effect of a
 * conversion is a new job in the org — and ESTIMATE_READ is additionally
 * required because the action reads estimate data into that job (both names are
 * existing enum values; the pairing is the documented default and can be
 * overridden later without a migration).
 *
 * The job creation, the conversion marker (Job.estimateId), the linked-job
 * association (Estimate.jobId) and the CREATE audit row share ONE transaction.
 * The once-only rule is enforced by @@unique([organizationId, estimateId]):
 * the repository pre-checks for a friendly message, and a concurrent second
 * convert loses at the unique index, rolls back whole, and surfaces as
 * CONFLICT. The estimate keeps its ACCEPTED status — the conversion is recorded
 * on the job side, never by mutating the lifecycle.
 */
export async function convertEstimateToJob(input: unknown): Promise<ActionResult<ConvertEstimateToJobResult>> {
  try {
    const ctx = await requirePermission(Permission.JOB_CREATE);
    // The conversion also consumes an estimate; hold its read permission too.
    if (!(await hasPermission(ctx.organizationId, ctx.membership.role, Permission.ESTIMATE_READ))) {
      throw new ForbiddenError(
        `Missing permission: ${Permission.ESTIMATE_READ}. Your role (${ctx.membership.role}) does not allow this.`,
      );
    }
    const { id } = estimateConvertSchema.parse(input);
    const job = await db.$transaction(async (tx) => {
      const created = await createJobRepo(tx, ctx.organizationId).createFromEstimate(id);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.CREATE,
          entityType: "Job",
          entityId: created.id,
          before: toAuditJson(null),
          after: toAuditJson(convertedJobSnapshot(created)),
          metadata: toAuditJson({ convertedFromEstimateId: id }),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      return created;
    });
    revalidateEstimates(ctx.organization.slug, id);
    revalidatePath(`/${ctx.organization.slug}/jobs`);
    return { ok: true, data: { estimateId: id, jobId: job.id, jobNumber: job.jobNumber, jobTitle: job.title } };
  } catch (err) {
    return actionError(err);
  }
}
