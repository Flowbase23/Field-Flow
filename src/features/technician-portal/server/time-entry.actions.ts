/**
 * Technician portal server actions (Phase 2 Slice P2-S5) — time entry logging.
 *
 * Conventions (as every other feature): requirePermission → Zod → tenant-scoped
 * repo → audit in the same transaction → ActionResult.
 *
 * Guards:
 *   logTimeEntry → TIME_CREATE
 *
 * Self-scoping decision: the technicianId on every entry is resolved from the
 * SESSION user via TechnicianRepo.getByUserId — there is no client-supplied
 * technicianId at all, so a technician (or anyone with TIME_CREATE) can only
 * ever log time as themselves. Users without a Technician record in the org
 * (office staff etc.) get a clear NOT_FOUND. Job links are validated in the
 * repository: in-org AND the technician must be assigned to the job
 * (JobTechnician join), so time can only be logged against the technician's
 * own jobs. Duration rules (positive whole minutes, ≤24h, span consistency)
 * are enforced in the repository — server-authoritative, never trusted from
 * the client.
 */
"use server";

import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/require-org";
import { tenantRepositories } from "@/server/repositories";
import { db } from "@/server/db/client";
import { withAudit } from "@/server/audit";
import { NotFoundError, ValidationError, actionError, type ActionResult } from "@/lib/errors";
import { resolveLoggedSpan } from "../technician-portal-ui";
import { timeEntryCreateSchema, type TimeEntryCreateInput } from "../schemas";

export interface TimeEntryActionResult {
  id: string;
  minutes: number;
  jobId: string | null;
}

/**
 * The signed-in user's own technician record in this org. Throws NotFoundError
 * when the user has no Technician record (or it is inactive) — the portal pages
 * show a friendly empty state for the read paths and the action rejects.
 */
export async function requireSelfTechnician(organizationId: string, userId: string) {
  const self = await tenantRepositories(db, organizationId).technicians.getByUserId(userId);
  if (!self) {
    throw new NotFoundError("You are not set up as a technician in this organization.");
  }
  if (!self.isActive) {
    throw new NotFoundError("Your technician record is inactive in this organization.");
  }
  return self;
}

/**
 * Log a time entry for the signed-in technician. Guards: TIME_CREATE, Zod,
 * self technician resolution, tenant+assignment checks in the repo, audit row
 * (CREATE, snapshot) in the same transaction.
 */
export async function logTimeEntry(input: unknown): Promise<ActionResult<TimeEntryActionResult>> {
  try {
    const ctx = await requirePermission(Permission.TIME_CREATE);
    // Zod failures surface as VALIDATION (not INTERNAL): map the ZodError to
    // the project's ValidationError before actionError serializes it.
    const parsed = timeEntryCreateSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        "Invalid time entry.",
        parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      );
    }
    const data: TimeEntryCreateInput = parsed.data;
    const self = await requireSelfTechnician(ctx.organizationId, ctx.userId);
    // Wall-clock inputs are resolved in the ORGANIZATION timezone; the stored
    // minutes are always server-derived (see resolveLoggedSpan).
    const span = resolveLoggedSpan(
      { workDate: data.workDate, hours: data.hours, startTime: data.startTime, endTime: data.endTime },
      ctx.organization.timezone,
    );

    const created = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.CREATE,
        entityType: "TimeEntry",
        entityId: undefined,
        before: null,
        after: {
          technicianId: self.id,
          jobId: data.jobId ?? null,
          workDate: data.workDate,
          startedAt: span.startedAt.toISOString(),
          endedAt: span.endedAt?.toISOString() ?? null,
          minutes: span.minutes,
          billable: data.billable,
        },
        metadata: { source: "technician-portal" },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) =>
        tenantRepositories(tx, ctx.organizationId).timeEntries.create({
          technicianId: self.id,
          jobId: data.jobId ?? null,
          startedAt: span.startedAt,
          endedAt: span.endedAt,
          minutes: span.minutes,
          billable: data.billable,
        }),
    );

    revalidatePath(`/${ctx.organization.slug}/my-time`);
    if (data.jobId) revalidatePath(`/${ctx.organization.slug}/my-jobs/${data.jobId}`);
    return { ok: true, data: { id: created.id, minutes: created.minutes ?? 0, jobId: created.jobId } };
  } catch (err) {
    return actionError(err);
  }
}
