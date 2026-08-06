/**
 * Technician repository — tenant-scoped access to the Technician model
 * (Phase 1, Slice 4). Follows the createCustomerRepo pattern (design §2,
 * mechanism B): every query injects the organizationId predicate; cross-tenant
 * ids are indistinguishable from missing rows.
 *
 * Technician.user is the global (non-tenant) User record; display names are
 * resolved here in a batch query, exactly like lead.repo resolves owners.
 *
 * The repository is DB-only: input is expected to be already validated (Zod)
 * and authorized (requirePermission) by the caller.
 */
import type { Prisma, PrismaClient, Technician, User } from "@prisma/client";

export interface TechnicianUserSummary {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

export interface TechnicianWithUser extends Technician {
  user: TechnicianUserSummary;
}

export interface TechnicianRepo {
  /** ACTIVE technicians in the org, name-ordered — the picker source. */
  listActive(): Promise<TechnicianWithUser[]>;
  /** Tenant-scoped lookup; cross-tenant ids return null (→ NotFoundError upstream). */
  getById(id: string): Promise<TechnicianWithUser | null>;
  /** Tenant-scoped batch lookup (used to validate technicianIds on create/update). */
  listByIds(ids: string[]): Promise<TechnicianWithUser[]>;
}

type Client = Prisma.TransactionClient | PrismaClient;

const userSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
} as const;

export function createTechnicianRepo(prisma: Client, organizationId: string): TechnicianRepo {
  const tenant = { organizationId } as const;

  return {
    async listActive() {
      return prisma.technician.findMany({
        where: { ...tenant, isActive: true },
        include: { user: { select: userSelect } },
        orderBy: [{ user: { firstName: "asc" } }, { user: { lastName: "asc" } }],
      });
    },

    async getById(id) {
      return prisma.technician.findFirst({
        where: { id, ...tenant },
        include: { user: { select: userSelect } },
      });
    },

    async listByIds(ids) {
      if (ids.length === 0) return [];
      return prisma.technician.findMany({
        where: { id: { in: ids }, ...tenant },
        include: { user: { select: userSelect } },
      });
    },
  };
}

/** Display name for a technician ("Jane Doe", falling back to email). */
export function technicianDisplayName(tech: { user: Pick<User, "firstName" | "lastName" | "email"> }): string {
  const first = tech.user.firstName?.trim() ?? "";
  const last = tech.user.lastName?.trim() ?? "";
  if (first || last) return `${first} ${last}`.trim();
  return tech.user.email;
}
