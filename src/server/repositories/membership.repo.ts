/**
 * Membership repository — tenant-scoped access to the Membership model
 * (Slice 2 follow-up). Follows the createCustomerRepo pattern: every query
 * injects the organizationId predicate.
 *
 * Membership has NO compound `@@unique([id, organizationId])` (see
 * prisma/schema.prisma), so mutations go through updateMany with the tenant
 * predicate — a foreign membership id yields count 0 → NotFoundError, making a
 * cross-tenant update impossible at the database level.
 */
import type { Membership, Prisma, PrismaClient, Role } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";

export interface MembershipUserSummary {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface MembershipWithUser extends Membership {
  user: MembershipUserSummary;
}

export interface MembershipRepo {
  /** All memberships in the org (newest last), with the member's user summary. */
  list(): Promise<MembershipWithUser[]>;
  /** Tenant-scoped lookup by membership id. */
  getById(id: string): Promise<Membership | null>;
  /** Tenant-scoped lookup by local user id (used by the invite flow). */
  getByUserId(userId: string): Promise<Membership | null>;
  /** Change the app role. Throws NotFoundError when the id is not in this org. */
  updateRole(id: string, role: Role): Promise<Membership>;
  /** Activate/deactivate. Throws NotFoundError when the id is not in this org. */
  updateActive(id: string, isActive: boolean): Promise<Membership>;
  /**
   * Invite-time sync: create/update the membership row for an already-known
   * local user (e.g. a user who exists in another org). New rows are created
   * INACTIVE (pending acceptance) — the webhook flips isActive on acceptance.
   */
  upsertForUser(userId: string, data: { role: Role; isActive?: boolean }): Promise<Membership>;
}

type Client = Prisma.TransactionClient | PrismaClient;

export function createMembershipRepo(prisma: Client, organizationId: string): MembershipRepo {
  const tenant = { organizationId } as const;

  async function updateWithGuard(
    id: string,
    data: Prisma.MembershipUpdateManyMutationInput,
  ): Promise<Membership> {
    const result = await prisma.membership.updateMany({ where: { id, ...tenant }, data });
    if (result.count !== 1) {
      throw new NotFoundError("Membership not found in this organization.");
    }
    const updated = await prisma.membership.findFirst({ where: { id, ...tenant } });
    if (!updated) {
      throw new NotFoundError("Membership not found in this organization.");
    }
    return updated;
  }

  return {
    async list() {
      return prisma.membership.findMany({
        where: tenant,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
        orderBy: { createdAt: "asc" },
      });
    },

    async getById(id) {
      return prisma.membership.findFirst({ where: { id, ...tenant } });
    },

    async getByUserId(userId) {
      return prisma.membership.findFirst({ where: { userId, ...tenant } });
    },

    async updateRole(id, role) {
      return updateWithGuard(id, { role });
    },

    async updateActive(id, isActive) {
      return updateWithGuard(id, { isActive });
    },

    async upsertForUser(userId, data) {
      return prisma.membership.upsert({
        where: { organizationId_userId: { organizationId, userId } },
        create: { ...tenant, userId, role: data.role, isActive: data.isActive ?? false },
        update: { role: data.role, isActive: data.isActive ?? false },
      });
    },
  };
}
