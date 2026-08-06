/**
 * Lead repository — tenant-scoped access to the Lead model (Phase 1, Slice 3).
 *
 * Follows the createCustomerRepo pattern (design §2, mechanism B): every query
 * injects the organizationId predicate; cross-tenant ids are indistinguishable
 * from missing rows.
 *
 * Unlike Customer/Location, Lead has NO `@@unique([id, organizationId])` in the
 * schema (Slice 1 deviation — optional tenant links use id-only FKs), so
 * mutations go through updateMany/deleteMany with the tenant predicate and a
 * count guard → count 0 throws NotFoundError. This makes a cross-tenant update
 * impossible at the database level even without the compound selector
 * (same pattern as membership.repo).
 *
 * The repository is DB-only: input is expected to be already validated (Zod)
 * and authorized (requirePermission) by the caller. Lead.ownerUserId has no
 * Prisma relation in the schema, so owner display names are resolved here with
 * a batch query on the (global) User model.
 */
import type { Lead, LeadSource, LeadStatus, Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError } from "@/lib/errors";

export interface LeadListParams {
  /** Case-insensitive match on title or description. */
  search?: string;
  status?: LeadStatus;
  source?: LeadSource;
  /** Local User.id of the assigned owner (sales rep). */
  ownerUserId?: string;
  /** Restrict to leads linked to this customer (customer detail page). */
  customerId?: string;
  page?: number; // 1-based
  pageSize?: number; // default 25, max 100
}

/** Scalar create input — organizationId is intentionally NOT part of this type. */
export interface LeadCreateData {
  title: string;
  source: LeadSource;
  status?: LeadStatus;
  description?: string | null;
  estimatedValueCents?: number | null;
  ownerUserId?: string | null;
  customerId?: string | null;
}

export type LeadUpdateData = Partial<LeadCreateData>;

/** Status + pipeline timestamp fields computed by applyLeadTransition. */
export interface LeadStatusUpdateData {
  status: LeadStatus;
  firstContactedAt?: Date | null;
  qualifiedAt?: Date | null;
  wonAt?: Date | null;
  lostAt?: Date | null;
  lostReason?: string | null;
}

export interface LeadCustomerSummary {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

export interface LeadOwnerSummary {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
}

export interface LeadWithRelations extends Lead {
  customer: LeadCustomerSummary | null;
  owner: LeadOwnerSummary | null;
}

export interface LeadRepo {
  list(params?: LeadListParams): Promise<LeadWithRelations[]>;
  count(params?: Omit<LeadListParams, "page" | "pageSize">): Promise<number>;
  /** Tenant-scoped lookup; cross-tenant ids return null (→ NotFoundError upstream). */
  getById(id: string): Promise<LeadWithRelations | null>;
  /** Leads linked to a customer, newest first (customer detail page). */
  listByCustomer(customerId: string, limit?: number): Promise<LeadWithRelations[]>;
  create(data: LeadCreateData): Promise<Lead>;
  update(id: string, data: LeadUpdateData): Promise<Lead>;
  /** Status transition write (also syncs pipelineStage). Throws NotFoundError off-tenant. */
  updateStatus(id: string, data: LeadStatusUpdateData): Promise<Lead>;
  /** Hard delete (the schema has no soft-delete flag on Lead). Throws NotFoundError off-tenant. */
  remove(id: string): Promise<Lead>;
}

type Client = Prisma.TransactionClient | PrismaClient;

const customerSelect = {
  id: true,
  firstName: true,
  lastName: true,
  companyName: true,
} as const;

const ownerSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
} as const;

/** A lead row as returned by Prisma with the customer summary include. */
type LeadWithCustomer = Lead & { customer: LeadCustomerSummary | null };

export function createLeadRepo(prisma: Client, organizationId: string): LeadRepo {
  const tenant = { organizationId } as const;

  /** Attach owner display names to lead rows (User is a global, non-tenant model). */
  async function withOwners(rows: LeadWithCustomer[]): Promise<LeadWithRelations[]> {
    if (rows.length === 0) return [];
    const ownerIds = [...new Set(rows.map((r) => r.ownerUserId).filter((id): id is string => Boolean(id)))];
    const owners = new Map<string, LeadOwnerSummary>();
    if (ownerIds.length > 0) {
      const found = await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: ownerSelect,
      });
      for (const user of found) owners.set(user.id, user);
    }
    return rows.map((row) => ({
      ...row,
      customer: row.customer,
      owner: row.ownerUserId ? (owners.get(row.ownerUserId) ?? null) : null,
    }));
  }

  return {
    async list(params = {}) {
      const { search, status, source, ownerUserId, customerId, page = 1, pageSize = 25 } = params;
      const where: Prisma.LeadWhereInput = {
        ...tenant,
        status,
        source,
        ownerUserId,
        customerId,
        ...(search
          ? {
              OR: [
                { title: { contains: search, mode: "insensitive" } },
                { description: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const rows = await prisma.lead.findMany({
        where,
        include: { customer: { select: customerSelect } },
        orderBy: [{ createdAt: "desc" }],
        take: Math.min(pageSize, 100),
        skip: (page - 1) * Math.min(pageSize, 100),
      });
      return withOwners(rows);
    },

    async count(params = {}) {
      const { search, status, source, ownerUserId, customerId } = params;
      return prisma.lead.count({
        where: {
          ...tenant,
          status,
          source,
          ownerUserId,
          customerId,
          ...(search
            ? {
                OR: [
                  { title: { contains: search, mode: "insensitive" } },
                  { description: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
      });
    },

    async getById(id) {
      const row = await prisma.lead.findFirst({
        where: { id, ...tenant },
        include: { customer: { select: customerSelect } },
      });
      if (!row) return null;
      return (await withOwners([row]))[0];
    },

    async listByCustomer(customerId, limit = 50) {
      const rows = await prisma.lead.findMany({
        where: { ...tenant, customerId },
        include: { customer: { select: customerSelect } },
        orderBy: [{ createdAt: "desc" }],
        take: Math.min(limit, 100),
      });
      return withOwners(rows);
    },

    async create(data) {
      return prisma.lead.create({ data: { ...tenant, ...data, pipelineStage: (data.status ?? "NEW").toLowerCase() } });
    },

    async update(id, data) {
      const result = await prisma.lead.updateMany({ where: { id, ...tenant }, data });
      if (result.count !== 1) {
        throw new NotFoundError("Lead not found in this organization.");
      }
      return prisma.lead.findFirstOrThrow({ where: { id, ...tenant } });
    },

    async updateStatus(id, data) {
      const { status, ...timestamps } = data;
      const result = await prisma.lead.updateMany({
        where: { id, ...tenant },
        data: { status, pipelineStage: status.toLowerCase(), ...timestamps },
      });
      if (result.count !== 1) {
        throw new NotFoundError("Lead not found in this organization.");
      }
      return prisma.lead.findFirstOrThrow({ where: { id, ...tenant } });
    },

    async remove(id) {
      const existing = await prisma.lead.findFirst({ where: { id, ...tenant } });
      if (!existing) {
        throw new NotFoundError("Lead not found in this organization.");
      }
      const result = await prisma.lead.deleteMany({ where: { id, ...tenant } });
      if (result.count !== 1) {
        throw new NotFoundError("Lead not found in this organization.");
      }
      return existing;
    },
  };
}
