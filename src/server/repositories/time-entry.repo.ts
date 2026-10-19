/**
 * TimeEntry repository — tenant-scoped access to the TimeEntry model
 * (Phase 2 Slice P2-S5, technician portal). Follows the createAppointmentRepo
 * pattern (design §2, mechanism B): every query injects the organizationId
 * predicate; cross-tenant ids are indistinguishable from missing rows.
 *
 * TimeEntry.job is an id-only FK (design header note 1), so the job's tenant
 * scope is verified HERE with a tenant-predicate lookup before the write
 * (mechanism B backstop). The technician FK is compound
 * (technicianId, organizationId) via Technician's @@unique([id, organizationId]),
 * so a cross-tenant technician id fails the relation at the database level; we
 * still verify it explicitly for a clear error message.
 *
 * Business rules enforced here (server-authoritative, the Zod layer only
 * shapes input):
 * - `minutes` must be a positive whole number of minutes (an integer count of
 *   minutes, no fractions/zero/negatives);
 * - when both start and end instants are given, `minutes` must equal the
 *   elapsed whole minutes and end must be after start — the stored duration is
 *   always the server-derived one, never a client-sent value;
 * - a linked job must belong to the org AND the technician must be ASSIGNED to
 *   it (JobTechnician join row) — a technician logs time only against their
 *   own jobs.
 *
 * The repository is DB-only: input is expected to be already validated (Zod)
 * and authorized (requirePermission) by the caller. There is deliberately no
 * update/delete path in this slice (owner-overridable decision): entries are
 * append-only, corrections are a follow-up.
 */
import type { Prisma, PrismaClient, TimeEntry } from "@prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";

export interface TimeEntryJobSummary {
  id: string;
  jobNumber: number;
  title: string;
}

export interface TimeEntryListItem extends TimeEntry {
  job: TimeEntryJobSummary | null;
}

export interface TimeEntryCreateData {
  technicianId: string;
  jobId?: string | null;
  startedAt: Date; // UTC
  endedAt?: Date | null; // UTC — only when a span was recorded
  minutes: number; // server-derived; see header
  billable?: boolean;
}

export interface TimeEntryListParams {
  jobId?: string;
  from?: Date; // inclusive (UTC)
  to?: Date; // exclusive (UTC)
}

export interface TimeEntryRepo {
  /** The org's entries for ONE technician, newest first (their own timesheet). */
  listForTechnician(technicianId: string, params?: TimeEntryListParams): Promise<TimeEntryListItem[]>;
  /** The org's entries for ONE job, optionally scoped to a single technician. */
  listForJob(jobId: string, params?: { technicianId?: string }): Promise<TimeEntryListItem[]>;
  /** Tenant-scoped lookup; cross-tenant ids return null (→ NotFoundError upstream). */
  getById(id: string): Promise<TimeEntryListItem | null>;
  /** Validated create (throws NotFoundError off-tenant job/technician or unassigned job). */
  create(data: TimeEntryCreateData): Promise<TimeEntry>;
}

type Client = Prisma.TransactionClient | PrismaClient;

const jobInclude = {
  job: { select: { id: true, jobNumber: true, title: true } },
} as const;

export function createTimeEntryRepo(prisma: Client, organizationId: string): TimeEntryRepo {
  const tenant = { organizationId } as const;

  /** Positive whole minutes only — fractions would hide rounding errors. */
  function assertPositiveMinutes(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 24 * 60) {
      throw new ValidationError("Time entries must record a positive duration of at most 24 hours.");
    }
  }

  return {
    async listForTechnician(technicianId, params = {}) {
      return prisma.timeEntry.findMany({
        where: {
          ...tenant,
          technicianId,
          ...(params.jobId ? { jobId: params.jobId } : {}),
          ...(params.from || params.to
            ? { startedAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lt: params.to } : {}) } }
            : {}),
        },
        include: jobInclude,
        orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
      });
    },

    async listForJob(jobId, params = {}) {
      return prisma.timeEntry.findMany({
        where: {
          ...tenant,
          jobId,
          ...(params.technicianId ? { technicianId: params.technicianId } : {}),
        },
        include: jobInclude,
        orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
      });
    },

    async getById(id) {
      return prisma.timeEntry.findFirst({ where: { id, ...tenant }, include: jobInclude });
    },

    async create(data) {
      // The duration is server-derived from the inputs the caller already
      // validated; it is never accepted verbatim from the client shape.
      assertPositiveMinutes(data.minutes);
      if (data.endedAt && !(data.endedAt.getTime() > data.startedAt.getTime())) {
        throw new ValidationError("End time must be after the start time.");
      }
      if (data.endedAt) {
        const elapsed = Math.round((data.endedAt.getTime() - data.startedAt.getTime()) / 60_000);
        if (elapsed !== data.minutes) {
          throw new ValidationError("Recorded minutes do not match the start/end times.");
        }
      }
      const technician = await prisma.technician.findFirst({
        where: { id: data.technicianId, ...tenant },
        select: { id: true },
      });
      if (!technician) throw new NotFoundError("The selected technician does not belong to this organization.");
      if (data.jobId) {
        const job = await prisma.job.findFirst({ where: { id: data.jobId, ...tenant }, select: { id: true } });
        if (!job) throw new NotFoundError("The linked job does not belong to this organization.");
        const assignment = await prisma.jobTechnician.findFirst({
          where: { jobId: data.jobId, technicianId: data.technicianId, ...tenant },
          select: { technicianId: true },
        });
        if (!assignment) {
          throw new NotFoundError("Time can only be logged against a job this technician is assigned to.");
        }
      }
      return prisma.timeEntry.create({
        data: {
          ...tenant,
          technicianId: data.technicianId,
          jobId: data.jobId ?? null,
          startedAt: data.startedAt,
          endedAt: data.endedAt ?? null,
          minutes: data.minutes,
          billable: data.billable ?? false,
        },
      });
    },
  };
}
