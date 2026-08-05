/**
 * Customer repository — the worked example of the tenant-scoped repository
 * pattern (design §2, defense-in-depth mechanism B).
 *
 * Every method takes the organizationId-bound client (see createCustomerRepo)
 * and injects the tenant predicate; updates/deletes use the compound
 * `id_organizationId` unique selector from the schema's `@@unique([id, organizationId])`
 * so a cross-tenant update is impossible at the database level (mechanism D).
 *
 * The repository layer is DB-only: input is expected to be already validated
 * (Zod, src/lib/validation.ts) and authorized (requirePermission) by the caller.
 */
import type { Customer, CustomerType, Prisma, PrismaClient } from "@prisma/client";

export interface CustomerListParams {
  /** Case-insensitive match on first/last name, company, email or phone. */
  search?: string;
  type?: CustomerType;
  isActive?: boolean;
  page?: number; // 1-based
  pageSize?: number; // default 25, max 100
}

/** Scalar create input — organizationId is intentionally NOT part of this type. */
export interface CustomerCreateData {
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  type?: CustomerType;
  notes?: string | null;
}

export type CustomerUpdateData = Partial<CustomerCreateData>;

export interface CustomerRepo {
  list(params?: CustomerListParams): Promise<Customer[]>;
  count(params?: Omit<CustomerListParams, "page" | "pageSize">): Promise<number>;
  getById(id: string): Promise<Customer | null>;
  create(data: CustomerCreateData): Promise<Customer>;
  update(id: string, data: CustomerUpdateData): Promise<Customer>;
  /** Soft delete (isActive = false); records are never hard-deleted. */
  remove(id: string): Promise<Customer>;
}

type Client = Prisma.TransactionClient | PrismaClient;

export function createCustomerRepo(prisma: Client, organizationId: string): CustomerRepo {
  const tenant = { organizationId } as const;

  return {
    async list(params = {}) {
      const { search, type, isActive, page = 1, pageSize = 25 } = params;
      return prisma.customer.findMany({
        where: {
          ...tenant,
          type,
          isActive,
          ...(search
            ? {
                OR: [
                  { firstName: { contains: search, mode: "insensitive" } },
                  { lastName: { contains: search, mode: "insensitive" } },
                  { companyName: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
                  { phone: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: "desc" }],
        take: Math.min(pageSize, 100),
        skip: (page - 1) * Math.min(pageSize, 100),
      });
    },

    async count(params = {}) {
      const { search, type, isActive } = params;
      return prisma.customer.count({
        where: {
          ...tenant,
          type,
          isActive,
          ...(search
            ? {
                OR: [
                  { firstName: { contains: search, mode: "insensitive" } },
                  { lastName: { contains: search, mode: "insensitive" } },
                  { companyName: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
                  { phone: { contains: search, mode: "insensitive" } },
                ],
              }
            : {}),
        },
      });
    },

    async getById(id) {
      return prisma.customer.findFirst({
        where: { id, ...tenant },
        include: { locations: true },
      });
    },

    async create(data) {
      return prisma.customer.create({ data: { ...tenant, ...data } });
    },

    async update(id, data) {
      // Compound unique selector — cross-tenant updates are rejected by the DB.
      return prisma.customer.update({
        where: { id_organizationId: { id, organizationId } },
        data,
      });
    },

    async remove(id) {
      return prisma.customer.update({
        where: { id_organizationId: { id, organizationId } },
        data: { isActive: false },
      });
    },
  };
}
