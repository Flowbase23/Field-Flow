/**
 * Appointment server actions (Phase 1, Slice 4) — create, update, cancel,
 * status transitions, mark-missed.
 *
 * Conventions (as customer/lead actions): requirePermission → Zod → tenant-
 * scoped repo → audit in the same transaction → ActionResult.
 *
 * Guard mapping:
 *   createAppointment    → SCHEDULE_CREATE
 *   updateAppointment    → SCHEDULE_UPDATE
 *   setAppointmentStatus → SCHEDULE_UPDATE
 *   markMissed           → SCHEDULE_UPDATE
 *   cancelAppointment    → SCHEDULE_DELETE  (cancellation is the delete-like op,
 *                            mirroring setCustomerActive's CUSTOMER_DELETE gate)
 *
 * Conflict policy (Slice 4 brief): on create/update, an appointment that
 * overlaps an existing appointment for the SAME technician (including travel
 * buffers, half-open [start, end) intervals) is rejected with a clear error
 * naming the conflicting appointment — UNLESS the caller holds SCHEDULE_UPDATE
 * and passes `allowOverlap: true` (Dispatcher/Admin override). The override
 * check uses the caller's EFFECTIVE permissions (permissionsFor), not just the
 * action's own gate, so a SCHEDULE_CREATE-only user cannot bypass conflicts.
 *
 * Timezone model: input startsAt/endsAt are wall-clock datetimes in the
 * provided `timezone` (default: org timezone); they are converted to UTC for
 * storage here (localDateTimeToUtc) and back for display.
 *
 * Status transitions are server-enforced via applyAppointmentTransition
 * (src/server/domain/appointment-transitions.ts) — the map is the ONLY path a
 * status change can take, and every transition is audited (STATUS_CHANGED with
 * before/after). Same-status updates are no-ops (nothing to audit).
 *
 * PENDING LIVE VERIFICATION: requirePermission() needs a real Clerk session;
 * DB writes are untested until the verification pass.
 */
"use server";

import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { createAppointmentRepo } from "@/server/repositories/appointment.repo";
import { createTechnicianRepo, technicianDisplayName } from "@/server/repositories/technician.repo";
import { db } from "@/server/db/client";
import { withAudit } from "@/server/audit";
import { ConflictError, NotFoundError, ValidationError, actionError, type ActionResult } from "@/lib/errors";
import { localDateTimeToUtc } from "@/lib/dates";
import { applyAppointmentTransition } from "@/server/domain/appointment-transitions";
import {
  findTechnicianConflicts,
  conflictMessage,
  effectiveSpan,
} from "@/features/schedule/conflicts";
import {
  appointmentCancelSchema,
  appointmentCreateSchema,
  appointmentMarkMissedSchema,
  appointmentSetStatusSchema,
  appointmentUpdateActionSchema,
  type AppointmentCreateInput,
  type AppointmentUpdateActionInput,
} from "../schemas";

export interface AppointmentActionResult {
  id: string;
  title: string;
  status: string;
  startsAt: string; // UTC ISO
  endsAt: string; // UTC ISO
}

function appointmentSnapshot(appt: {
  title: string;
  type: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  travelMinutesBefore: number;
  travelMinutesAfter: number;
  jobId: string | null;
  locationId: string | null;
  notes: string | null;
}): Record<string, unknown> {
  return {
    title: appt.title,
    type: appt.type,
    status: appt.status,
    startsAt: appt.startsAt.toISOString(),
    endsAt: appt.endsAt.toISOString(),
    timezone: appt.timezone,
    travelMinutesBefore: appt.travelMinutesBefore,
    travelMinutesAfter: appt.travelMinutesAfter,
    jobId: appt.jobId,
    locationId: appt.locationId,
    notes: appt.notes,
  };
}

/** Revalidate every schedule view (the whole calendar re-reads the range). */
function revalidateSchedule(orgSlug: string): void {
  revalidatePath(`/${orgSlug}/schedule`);
}

/**
 * Convert wall-clock datetimes to UTC instants in the appointment timezone.
 * `startsAt`/`endsAt` come from the Zod schema (already validated format).
 */
function toUtcTimes(data: { startsAt: string; endsAt: string; timezone: string }): {
  startsAt: Date;
  endsAt: Date;
} {
  const startsAt = localDateTimeToUtc(data.startsAt, data.timezone);
  const endsAt = localDateTimeToUtc(data.endsAt, data.timezone);
  if (!(endsAt.getTime() > startsAt.getTime())) {
    // Zod already guards this; keep the invariant server-side too.
    throw new ValidationError("End time must be after the start time.");
  }
  return { startsAt, endsAt };
}

/** Load ACTIVE technicians for the org, keyed by id, validating the input set. */
async function loadTechnicians(organizationId: string, technicianIds: string[]) {
  const techRepo = createTechnicianRepo(db, organizationId);
  const found = await techRepo.listByIds(technicianIds);
  const foundIds = new Set(found.map((t) => t.id));
  const missing = technicianIds.filter((id) => !foundIds.has(id));
  const inactive = found.filter((t) => !t.isActive).map((t) => t.id);
  if (missing.length > 0 || inactive.length > 0) {
    throw new NotFoundError(
      `One or more assigned technicians are not active in this organization (${[...missing, ...inactive].join(", ")}).`,
    );
  }
  const byId = new Map(found.map((t) => [t.id, t]));
  return { byId };
}

/**
 * Conflict gate shared by create/update. Queries the tenant-scoped candidates
 * overlapping the EFFECTIVE (buffer-inclusive) window and rejects with a clear
 * error naming the conflicting appointment, unless the caller holds
 * SCHEDULE_UPDATE and passed allowOverlap.
 */
async function assertNoConflicts(opts: {
  organizationId: string;
  technicianIds: string[];
  startsAt: Date;
  endsAt: Date;
  travelMinutesBefore: number;
  travelMinutesAfter: number;
  allowOverlap?: boolean;
  excludeAppointmentId?: string;
  timeZone: string;
  canUpdate: boolean;
}) {
  if (opts.technicianIds.length === 0) return; // no assigned tech → nothing to double-book
  const eff = effectiveSpan(opts);
  const candidates = await createAppointmentRepo(db, opts.organizationId).findOverlapping({
    start: eff.start,
    end: eff.end,
    technicianIds: opts.technicianIds,
    excludeAppointmentId: opts.excludeAppointmentId,
  });
  const conflicts = findTechnicianConflicts(
    {
      startsAt: opts.startsAt,
      endsAt: opts.endsAt,
      travelMinutesBefore: opts.travelMinutesBefore,
      travelMinutesAfter: opts.travelMinutesAfter,
      technicianIds: opts.technicianIds,
    },
    candidates.map((c) => ({
      id: c.id,
      title: c.title,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      travelMinutesBefore: c.travelMinutesBefore,
      travelMinutesAfter: c.travelMinutesAfter,
      technicianIds: c.technicians.map((t) => t.technicianId),
    })),
  );
  if (conflicts.length === 0) return;
  const overridden = opts.allowOverlap === true && opts.canUpdate;
  if (overridden) return; // Dispatcher/Admin explicit override
  const first = conflicts[0];
  const tech = opts.technicianIds.length > 0 ? await loadTechnicians(opts.organizationId, [first.technicianId]).then((r) => r.byId.get(first.technicianId)) : undefined;
  throw new ConflictError(
    conflictMessage(first, tech ? technicianDisplayName(tech) : first.technicianId, opts.timeZone),
  );
}

/**
 * Create an appointment.
 * Guards: SCHEDULE_CREATE, Zod schema, technicians/job/location tenant-scoped,
 * conflict check (unless SCHEDULE_UPDATE + allowOverlap). Audited (CREATE).
 */
export async function createAppointment(input: unknown): Promise<ActionResult<AppointmentActionResult>> {
  try {
    const ctx = await requirePermission(Permission.SCHEDULE_CREATE);
    const data: AppointmentCreateInput & { allowOverlap?: boolean } = appointmentCreateSchema.parse(input);
    const { allowOverlap, ...fields } = data;
    const timezone = fields.timezone || ctx.organization.timezone;
    const { startsAt, endsAt } = toUtcTimes({ startsAt: fields.startsAt, endsAt: fields.endsAt, timezone });
    const techRepo = createTechnicianRepo(db, ctx.organizationId);
    const technicians = await techRepo.listByIds(fields.technicianIds);
    const foundIds = new Set(technicians.map((t) => t.id));
    const missing = fields.technicianIds.filter((id) => !foundIds.has(id) || !technicians.find((t) => t.id === id)?.isActive);
    if (missing.length > 0) {
      throw new NotFoundError(
        `One or more assigned technicians are not active in this organization (${missing.join(", ")}).`,
      );
    }

    const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
    const canUpdate = permissions.includes(Permission.SCHEDULE_UPDATE);
    await assertNoConflicts({
      organizationId: ctx.organizationId,
      technicianIds: fields.technicianIds,
      startsAt,
      endsAt,
      travelMinutesBefore: fields.travelMinutesBefore ?? 0,
      travelMinutesAfter: fields.travelMinutesAfter ?? 0,
      allowOverlap,
      timeZone: timezone,
      canUpdate,
    });

    const created = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.CREATE,
        entityType: "Appointment",
        entityId: undefined,
        before: null,
        after: appointmentSnapshot({
          title: fields.title,
          type: fields.type,
          status: "TENTATIVE",
          startsAt,
          endsAt,
          timezone,
          travelMinutesBefore: fields.travelMinutesBefore ?? 0,
          travelMinutesAfter: fields.travelMinutesAfter ?? 0,
          jobId: fields.jobId ?? null,
          locationId: fields.locationId ?? null,
          notes: fields.notes ?? null,
        }),
        metadata: { technicianIds: fields.technicianIds, allowOverlap: overriddenFlag(allowOverlap, canUpdate) },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) =>
        createAppointmentRepo(tx, ctx.organizationId).create(
          {
            jobId: fields.jobId ?? null,
            locationId: fields.locationId ?? null,
            createdByUserId: ctx.userId,
            type: fields.type,
            title: fields.title,
            startsAt,
            endsAt,
            timezone,
            travelMinutesBefore: fields.travelMinutesBefore ?? 0,
            travelMinutesAfter: fields.travelMinutesAfter ?? 0,
            notes: fields.notes ?? null,
          },
          fields.technicianIds,
        ),
    );

    revalidateSchedule(ctx.organization.slug);
    return {
      ok: true,
      data: {
        id: created.id,
        title: created.title,
        status: created.status,
        startsAt: created.startsAt.toISOString(),
        endsAt: created.endsAt.toISOString(),
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

/** True when the allowOverlap flag was HONORED (SCHEDULE_UPDATE + explicit flag). */
function overriddenFlag(allowOverlap: boolean | undefined, canUpdate: boolean): boolean {
  return allowOverlap === true && canUpdate;
}

/**
 * Update an appointment (times, technicians, links, notes, travel).
 * Guards: SCHEDULE_UPDATE, Zod schema, tenant-scoped target + links/techs,
 * conflict check excluding the record itself. Audited (UPDATE, before/after).
 */
export async function updateAppointment(input: unknown): Promise<ActionResult<AppointmentActionResult>> {
  try {
    const ctx = await requirePermission(Permission.SCHEDULE_UPDATE);
    const { id, ...data }: AppointmentUpdateActionInput & { allowOverlap?: boolean } = appointmentUpdateActionSchema.parse(input);
    const { allowOverlap, ...fields } = data;

    const repo = createAppointmentRepo(db, ctx.organizationId);
    const existing = await repo.getById(id);
    if (!existing) {
      throw new NotFoundError("Appointment not found in this organization.");
    }

    const timezone = fields.timezone ?? existing.timezone;
    const startsAt = fields.startsAt !== undefined ? localDateTimeToUtc(fields.startsAt, timezone) : existing.startsAt;
    const endsAt = fields.endsAt !== undefined ? localDateTimeToUtc(fields.endsAt, timezone) : existing.endsAt;
    if (!(endsAt.getTime() > startsAt.getTime())) {
      throw new ValidationError("End time must be after the start time.");
    }
    const technicianIds = fields.technicianIds ?? existing.technicians.map((t) => t.technicianId);
    await loadTechnicians(ctx.organizationId, technicianIds);

    await assertNoConflicts({
      organizationId: ctx.organizationId,
      technicianIds,
      startsAt,
      endsAt,
      travelMinutesBefore: fields.travelMinutesBefore ?? existing.travelMinutesBefore,
      travelMinutesAfter: fields.travelMinutesAfter ?? existing.travelMinutesAfter,
      allowOverlap,
      excludeAppointmentId: id,
      timeZone: timezone,
      canUpdate: true, // the action gate already requires SCHEDULE_UPDATE
    });

    const after = {
      title: fields.title ?? existing.title,
      type: fields.type ?? existing.type,
      status: existing.status,
      startsAt,
      endsAt,
      timezone,
      travelMinutesBefore: fields.travelMinutesBefore ?? existing.travelMinutesBefore,
      travelMinutesAfter: fields.travelMinutesAfter ?? existing.travelMinutesAfter,
      jobId: fields.jobId !== undefined ? fields.jobId : existing.jobId,
      locationId: fields.locationId !== undefined ? fields.locationId : existing.locationId,
      notes: fields.notes !== undefined ? fields.notes : existing.notes,
    };

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.UPDATE,
        entityType: "Appointment",
        entityId: id,
        before: appointmentSnapshot({
          title: existing.title,
          type: existing.type,
          status: existing.status,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          timezone: existing.timezone,
          travelMinutesBefore: existing.travelMinutesBefore,
          travelMinutesAfter: existing.travelMinutesAfter,
          jobId: existing.jobId,
          locationId: existing.locationId,
          notes: existing.notes,
        }),
        after,
        metadata: { technicianIds, allowOverlap: overriddenFlag(allowOverlap, true) },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) =>
        createAppointmentRepo(tx, ctx.organizationId).update(
          id,
          {
            title: fields.title,
            type: fields.type,
            startsAt: fields.startsAt !== undefined ? startsAt : undefined,
            endsAt: fields.endsAt !== undefined ? endsAt : undefined,
            timezone: fields.timezone,
            travelMinutesBefore: fields.travelMinutesBefore,
            travelMinutesAfter: fields.travelMinutesAfter,
            jobId: fields.jobId !== undefined ? fields.jobId : undefined,
            locationId: fields.locationId !== undefined ? fields.locationId : undefined,
            notes: fields.notes,
          },
          fields.technicianIds !== undefined ? technicianIds : undefined,
        ),
    );

    revalidateSchedule(ctx.organization.slug);
    return {
      ok: true,
      data: {
        id: updated.id,
        title: updated.title,
        status: updated.status,
        startsAt: updated.startsAt.toISOString(),
        endsAt: updated.endsAt.toISOString(),
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Cancel an appointment (status → CANCELLED). Guards: SCHEDULE_DELETE, Zod,
 * tenant-scoped target; the transition map rejects cancelling a terminal
 * appointment (COMPLETED/MISSED). Already-cancelled → no-op. Audited
 * (STATUS_CHANGED, before/after).
 */
export async function cancelAppointment(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const ctx = await requirePermission(Permission.SCHEDULE_DELETE);
    const { id } = appointmentCancelSchema.parse(input);

    const repo = createAppointmentRepo(db, ctx.organizationId);
    const existing = await repo.getById(id);
    if (!existing) {
      throw new NotFoundError("Appointment not found in this organization.");
    }
    if (existing.status === "CANCELLED") {
      return { ok: true, data: { id, status: "CANCELLED" } }; // no-op
    }

    // Enforce the map: CANCELLED is reachable only from non-terminal statuses.
    applyAppointmentTransition(existing.status, "CANCELLED");

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.STATUS_CHANGED,
        entityType: "Appointment",
        entityId: id,
        before: { status: existing.status },
        after: { status: "CANCELLED" },
        metadata: { operation: "cancel" },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createAppointmentRepo(tx, ctx.organizationId).cancel(id),
    );

    revalidateSchedule(ctx.organization.slug);
    return { ok: true, data: { id, status: updated.status } };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Change an appointment's status through the enforced transition map.
 * Guards: SCHEDULE_UPDATE, Zod, tenant-scoped target. Same-status → no-op.
 * Audited (STATUS_CHANGED, before/after including transition timestamps).
 */
export async function setAppointmentStatus(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const ctx = await requirePermission(Permission.SCHEDULE_UPDATE);
    const { id, status } = appointmentSetStatusSchema.parse(input);

    const repo = createAppointmentRepo(db, ctx.organizationId);
    const existing = await repo.getById(id);
    if (!existing) {
      throw new NotFoundError("Appointment not found in this organization.");
    }

    const fields = applyAppointmentTransition(existing.status, status);
    if (Object.keys(fields).length === 0) {
      return { ok: true, data: { id, status } }; // same-status no-op — nothing to audit
    }

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.STATUS_CHANGED,
        entityType: "Appointment",
        entityId: id,
        before: { status: existing.status },
        after: { status, ...fields },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) =>
        createAppointmentRepo(tx, ctx.organizationId).updateStatus(id, {
          status,
          actualStartAt: fields.actualStartAt ?? null,
          actualEndAt: fields.actualEndAt ?? null,
          missedAt: fields.missedAt ?? null,
        }),
    );

    revalidateSchedule(ctx.organization.slug);
    return { ok: true, data: { id, status: updated.status } };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Manually mark an appointment as missed. Guards: SCHEDULE_UPDATE, Zod,
 * tenant-scoped target; the map allows MISSED only from CONFIRMED / EN_ROUTE /
 * IN_PROGRESS. Already MISSED → no-op. Audited (STATUS_CHANGED).
 */
export async function markAppointmentMissed(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const ctx = await requirePermission(Permission.SCHEDULE_UPDATE);
    const { id } = appointmentMarkMissedSchema.parse(input);

    const repo = createAppointmentRepo(db, ctx.organizationId);
    const existing = await repo.getById(id);
    if (!existing) {
      throw new NotFoundError("Appointment not found in this organization.");
    }

    const fields = applyAppointmentTransition(existing.status, "MISSED");
    if (Object.keys(fields).length === 0) {
      return { ok: true, data: { id, status: "MISSED" } }; // no-op
    }

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.STATUS_CHANGED,
        entityType: "Appointment",
        entityId: id,
        before: { status: existing.status },
        after: { status: "MISSED", ...fields },
        metadata: { operation: "mark-missed" },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) =>
        createAppointmentRepo(tx, ctx.organizationId).updateStatus(id, {
          status: "MISSED",
          missedAt: fields.missedAt ?? null,
        }),
    );

    revalidateSchedule(ctx.organization.slug);
    return { ok: true, data: { id, status: updated.status } };
  } catch (err) {
    return actionError(err);
  }
}
