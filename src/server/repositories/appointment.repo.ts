/**
 * Appointment repository — tenant-scoped access to the Appointment model
 * (Phase 1, Slice 4). Follows the createCustomerRepo pattern (design §2,
 * mechanism B): every query injects the organizationId predicate.
 *
 * Appointment HAS `@@unique([id, organizationId])`, so mutations use the
 * compound `id_organizationId` selector — a cross-tenant update is impossible
 * at the database level (mechanism D). Appointment.job/location are id-only
 * FKs (Slice 1 deviation), so tenant-scope of any jobId/locationId is verified
 * HERE with tenant-predicate lookups before the write (mechanism B backstop).
 *
 * Technician assignment is the AppointmentTechnician join: create/update
 * replace the join rows wholesale (the join has @@id([appointmentId,
 * technicianId]) and no timestamps).
 *
 * The repository is DB-only: input is expected to be already validated (Zod)
 * and authorized (requirePermission) by the caller.
 */
import type { Appointment, AppointmentStatus, Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";

export interface AppointmentTechnicianSummary {
  technicianId: string;
  technician: {
    id: string;
    user: { id: string; firstName: string | null; lastName: string | null; email: string };
  };
}

export interface AppointmentListItem extends Appointment {
  technicians: AppointmentTechnicianSummary[];
  job: { id: string; title: string } | null;
  location: { id: string; label: string } | null;
}

/** Scalar create input — organizationId is intentionally NOT part of this type. */
export interface AppointmentCreateData {
  jobId?: string | null;
  locationId?: string | null;
  createdByUserId?: string | null;
  type: Appointment["type"];
  status?: AppointmentStatus;
  title: string;
  startsAt: Date; // UTC
  endsAt: Date; // UTC
  timezone: string;
  travelMinutesBefore?: number;
  travelMinutesAfter?: number;
  notes?: string | null;
}

export type AppointmentUpdateData = Partial<AppointmentCreateData>;

/** Status + transition timestamps computed by applyAppointmentTransition. */
export interface AppointmentStatusUpdateData {
  status: AppointmentStatus;
  actualStartAt?: Date | null;
  actualEndAt?: Date | null;
  missedAt?: Date | null;
}

export interface AppointmentRangeParams {
  start: Date; // inclusive window start (UTC)
  end: Date; // exclusive window end (UTC)
  /** Restrict to appointments involving ANY of these technicians. */
  technicianIds?: string[];
}

export interface AppointmentRepo {
  /** Appointments overlapping [start, end) for the org, with tech/job/location. */
  listInRange(params: AppointmentRangeParams): Promise<AppointmentListItem[]>;
  /** Tenant-scoped lookup; cross-tenant ids return null (→ NotFoundError upstream). */
  getById(id: string): Promise<AppointmentListItem | null>;
  /**
   * Tenant-scoped candidates for conflict detection: appointments that involve
   * one of `technicianIds` and overlap [start, end), excluding
   * `excludeAppointmentId`. The pure conflict helper
   * (features/schedule/conflicts.ts) does the precise buffer-aware check.
   */
  findOverlapping(params: AppointmentRangeParams & { excludeAppointmentId?: string }): Promise<AppointmentListItem[]>;
  /** Create + technician join rows in one write. Throws NotFoundError off-tenant links. */
  create(data: AppointmentCreateData, technicianIds: string[]): Promise<Appointment>;
  /** Update + replace technician join rows. Throws NotFoundError off-tenant (id or links). */
  update(id: string, data: AppointmentUpdateData, technicianIds?: string[]): Promise<Appointment>;
  /** Status transition write (status + timestamps). Throws NotFoundError off-tenant. */
  updateStatus(id: string, data: AppointmentStatusUpdateData): Promise<Appointment>;
  /** Cancel (status → CANCELLED). Throws NotFoundError off-tenant. */
  cancel(id: string): Promise<Appointment>;
}

type Client = Prisma.TransactionClient | PrismaClient;

const listInclude = {
  technicians: {
    include: {
      technician: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
    },
  },
  job: { select: { id: true, title: true } },
  location: { select: { id: true, label: true } },
} as const;

export function createAppointmentRepo(prisma: Client, organizationId: string): AppointmentRepo {
  const tenant = { organizationId } as const;

  /** jobId/locationId are id-only FKs — verify tenant-scope before every write. */
  async function assertLinksInOrg(data: { jobId?: string | null; locationId?: string | null }): Promise<void> {
    if (data.jobId) {
      const job = await prisma.job.findFirst({ where: { id: data.jobId, ...tenant }, select: { id: true } });
      if (!job) {
        throw new NotFoundError("The linked job does not belong to this organization.");
      }
    }
    if (data.locationId) {
      const location = await prisma.location.findFirst({
        where: { id: data.locationId, ...tenant },
        select: { id: true },
      });
      if (!location) {
        throw new NotFoundError("The linked location does not belong to this organization.");
      }
    }
  }

  return {
    async listInRange({ start, end, technicianIds }) {
      return prisma.appointment.findMany({
        where: {
          ...tenant,
          startsAt: { lt: end },
          endsAt: { gt: start },
          ...(technicianIds && technicianIds.length > 0
            ? { technicians: { some: { technicianId: { in: technicianIds } } } }
            : {}),
        },
        include: listInclude,
        orderBy: [{ startsAt: "asc" }],
      });
    },

    async getById(id) {
      return prisma.appointment.findFirst({ where: { id, ...tenant }, include: listInclude });
    },

    async findOverlapping({ start, end, technicianIds, excludeAppointmentId }) {
      if (!technicianIds || technicianIds.length === 0) return [];
      return prisma.appointment.findMany({
        where: {
          ...tenant,
          startsAt: { lt: end },
          endsAt: { gt: start },
          ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
          technicians: { some: { technicianId: { in: technicianIds } } },
        },
        include: listInclude,
      });
    },

    async create(data, technicianIds) {
      await assertLinksInOrg(data);
      return prisma.appointment.create({
        data: {
          ...tenant,
          ...data,
          technicians: {
            create: technicianIds.map((technicianId) => ({ technicianId, organizationId })),
          },
        },
      });
    },

    async update(id, data, technicianIds) {
      await assertLinksInOrg(data);
      const existing = await prisma.appointment.findFirst({ where: { id, ...tenant } });
      if (!existing) {
        throw new NotFoundError("Appointment not found in this organization.");
      }
      if (technicianIds !== undefined) {
        await prisma.appointmentTechnician.deleteMany({ where: { appointmentId: id, organizationId } });
        if (technicianIds.length > 0) {
          await prisma.appointmentTechnician.createMany({
            data: technicianIds.map((technicianId) => ({ appointmentId: id, technicianId, organizationId })),
          });
        }
      }
      return prisma.appointment.update({ where: { id_organizationId: { id, organizationId } }, data });
    },

    async updateStatus(id, data) {
      return prisma.appointment.update({
        where: { id_organizationId: { id, organizationId } },
        data: { status: data.status, actualStartAt: data.actualStartAt ?? undefined, actualEndAt: data.actualEndAt ?? undefined, missedAt: data.missedAt ?? undefined },
      });
    },

    async cancel(id) {
      return prisma.appointment.update({
        where: { id_organizationId: { id, organizationId } },
        data: { status: "CANCELLED" },
      });
    },
  };
}
