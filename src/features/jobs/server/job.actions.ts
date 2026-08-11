/**
 * Job server actions — Phase 1 Slice 5 domain foundation only (no dispatch UI).
 * Organization identity comes solely from Clerk-backed requirePermission(); the
 * browser payloads have no organizationId field. Each mutation and its audit row
 * share one database transaction.
 */
"use server";

import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { actionError, NotFoundError, type ActionResult } from "@/lib/errors";
import { toAuditJson, writeAuditLog } from "@/server/audit";
import { requirePermission } from "@/server/auth/require-org";
import { db } from "@/server/db/client";
import { createJobRepo } from "@/server/repositories/job.repo";
import { prepareJobStatusUpdate, updateJobStatus } from "@/server/services/job.service";
import {
  jobCreateSchema,
  jobReadSchema,
  jobStatusUpdateSchema,
  jobUpdateActionSchema,
  type JobCreateInput,
  type JobUpdateInput,
} from "../schemas";

export interface JobActionResult {
  id: string;
  jobNumber: number;
  status: string;
  title: string;
}

function jobSnapshot(job: {
  jobNumber?: number;
  customerId: string;
  locationId: string;
  leadId: string | null;
  type: string;
  priority: string;
  status: string;
  title: string;
  description: string | null;
  quotedAmountCents: number | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  actualRevenueCents: number | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
}) {
  return {
    jobNumber: job.jobNumber,
    customerId: job.customerId,
    locationId: job.locationId,
    leadId: job.leadId,
    type: job.type,
    priority: job.priority,
    status: job.status,
    title: job.title,
    description: job.description,
    quotedAmountCents: job.quotedAmountCents,
    subtotalCents: job.subtotalCents,
    taxCents: job.taxCents,
    totalCents: job.totalCents,
    actualRevenueCents: job.actualRevenueCents,
    completedAt: job.completedAt?.toISOString() ?? null,
    cancelledAt: job.cancelledAt?.toISOString() ?? null,
  };
}

function createSnapshot(data: JobCreateInput) {
  return jobSnapshot({ ...data, status: "DRAFT", completedAt: null, cancelledAt: null });
}

/** Build an audit snapshot without allowing undefined optional updates to erase fields. */
function updateSnapshot(existing: Parameters<typeof jobSnapshot>[0], data: JobUpdateInput) {
  return jobSnapshot({
    jobNumber: existing.jobNumber,
    customerId: data.customerId ?? existing.customerId,
    locationId: data.locationId ?? existing.locationId,
    leadId: data.leadId === undefined ? existing.leadId : data.leadId,
    type: data.type ?? existing.type,
    priority: data.priority ?? existing.priority,
    status: existing.status,
    title: data.title ?? existing.title,
    description: data.description === undefined ? existing.description : data.description,
    quotedAmountCents: data.quotedAmountCents === undefined ? existing.quotedAmountCents : data.quotedAmountCents,
    subtotalCents: data.subtotalCents ?? existing.subtotalCents,
    taxCents: data.taxCents ?? existing.taxCents,
    totalCents: data.totalCents ?? existing.totalCents,
    actualRevenueCents: data.actualRevenueCents === undefined ? existing.actualRevenueCents : data.actualRevenueCents,
    completedAt: existing.completedAt,
    cancelledAt: existing.cancelledAt,
  });
}

function revalidateJobs(orgSlug: string): void {
  revalidatePath(`/${orgSlug}/jobs`);
}

/** Tenant-scoped read primitive. JOB_READ is enforced independently of any UI. */
export async function getJob(input: unknown): Promise<ActionResult<JobActionResult>> {
  try {
    const ctx = await requirePermission(Permission.JOB_READ);
    const { id } = jobReadSchema.parse(input);
    const job = await createJobRepo(db, ctx.organizationId).getById(id);
    if (!job) throw new NotFoundError("Job not found in this organization.");
    return { ok: true, data: { id: job.id, jobNumber: job.jobNumber, status: job.status, title: job.title } };
  } catch (err) {
    return actionError(err);
  }
}

/** Create in DRAFT with an atomic tenant-local job number and CREATE audit record. */
export async function createJob(input: unknown): Promise<ActionResult<JobActionResult>> {
  try {
    const ctx = await requirePermission(Permission.JOB_CREATE);
    const data = jobCreateSchema.parse(input);
    const created = await db.$transaction(async (tx) => {
      const created = await createJobRepo(tx, ctx.organizationId).create(data);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.CREATE,
          entityType: "Job",
          entityId: created.id,
          before: toAuditJson(null),
          after: toAuditJson(jobSnapshot(created)),
          metadata: toAuditJson({ requested: createSnapshot(data) }),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      return created;
    });
    revalidateJobs(ctx.organization.slug);
    return { ok: true, data: { id: created.id, jobNumber: created.jobNumber, status: created.status, title: created.title } };
  } catch (err) {
    return actionError(err);
  }
}

/** Edit non-lifecycle fields after tenant-safe final relation validation and audit. */
export async function updateJob(input: unknown): Promise<ActionResult<JobActionResult>> {
  try {
    const ctx = await requirePermission(Permission.JOB_UPDATE);
    const { id, ...data } = jobUpdateActionSchema.parse(input);
    const updated = await db.$transaction(async (tx) => {
      const repo = createJobRepo(tx, ctx.organizationId);
      const existing = await repo.getById(id);
      if (!existing) throw new NotFoundError("Job not found in this organization.");

      const after = updateSnapshot(existing, data);
      const updated = await repo.update(id, data);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.UPDATE,
          entityType: "Job",
          entityId: id,
          before: toAuditJson(jobSnapshot(existing)),
          after: toAuditJson(after),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      return updated;
    });
    revalidateJobs(ctx.organization.slug);
    return { ok: true, data: { id: updated.id, jobNumber: updated.jobNumber, status: updated.status, title: updated.title } };
  } catch (err) {
    return actionError(err);
  }
}

/** Server-enforced lifecycle transition; only this action writes Job.status. */
export async function setJobStatus(input: unknown): Promise<ActionResult<JobActionResult>> {
  try {
    const ctx = await requirePermission(Permission.JOB_STATUS_UPDATE);
    const { id, status } = jobStatusUpdateSchema.parse(input);
    const result = await db.$transaction(async (tx) => {
      const repo = createJobRepo(tx, ctx.organizationId);
      const existing = await repo.getById(id);
      if (!existing) throw new NotFoundError("Job not found in this organization.");

      const now = new Date();
      const prepared = prepareJobStatusUpdate(existing.status, status, now);
      if (!prepared.changed) return { changed: false, job: existing };

      const transition = await updateJobStatus(repo, existing, status, now);
      if (!transition.job) throw new Error("Job status update unexpectedly produced no write.");
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.STATUS_CHANGED,
          entityType: "Job",
          entityId: id,
          before: toAuditJson(jobSnapshot(existing)),
          after: toAuditJson(jobSnapshot(transition.job)),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      return { changed: true, job: transition.job };
    });
    if (result.changed) revalidateJobs(ctx.organization.slug);
    return {
      ok: true,
      data: { id: result.job.id, jobNumber: result.job.jobNumber, status: result.job.status, title: result.job.title },
    };
  } catch (err) {
    return actionError(err);
  }
}
