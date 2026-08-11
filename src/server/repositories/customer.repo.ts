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
import type { Customer, CustomerType, Location, Prisma, PrismaClient } from "@prisma/client";

export interface CustomerListParams {
  /** Case-insensitive match on first/last name, company, email or phone. */
  search?: string;
  type?: CustomerType;
  isActive?: boolean;
  page?: number; // 1-based
  pageSize?: number; // default 25, max 100
  /** Include _count of locations/leads/jobs for list display (one extra COUNT per row batch). */
  withCounts?: boolean;
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

/** A customer plus its locations and relation counts (customer detail page). */
export interface CustomerDetail extends Customer {
  locations: Location[];
  _count: { jobs: number; leads: number; locations: number };
}

export interface CustomerWithLocations extends Customer {
  locations: Location[];
}

export interface CustomerRepo {
  list(params?: CustomerListParams): Promise<Customer[]>;
  /** Tenant-scoped customer/location options for Job create/edit forms. */
  listWithLocations(params?: Pick<CustomerListParams, "isActive">): Promise<CustomerWithLocations[]>;
  count(params?: Omit<CustomerListParams, "page" | "pageSize">): Promise<number>;
  getById(id: string): Promise<Customer | null>;
  /**
   * Customer with locations + relation counts for the detail page.
   * Cross-tenant ids return null (→ NotFoundError upstream).
   */
  getDetail(id: string): Promise<CustomerDetail | null>;
  /**
   * ACTIVE customers in this org matching email (case-insensitive) or phone —
   * the duplicate-policy candidate set (features/customers/duplicates.ts picks
   * the offender and formats the message).
   */
  findByEmailOrPhone(email?: string | null, phone?: string | null): Promise<Customer[]>;
  create(data: CustomerCreateData): Promise<Customer>;
  update(id: string, data: CustomerUpdateData): Promise<Customer>;
  /** Activate/deactivate (soft delete) via the compound selector. */
  setActive(id: string, isActive: boolean): Promise<Customer>;
  /** Soft delete (isActive = false); records are never hard-deleted. */
  remove(id: string): Promise<Customer>;
}

type Client = Prisma.TransactionClient | PrismaClient;

export function createCustomerRepo(prisma: Client, organizationId: string): CustomerRepo {
  const tenant = { organizationId } as const;

  return {
    async list(params = {}) {
      const { search, type, isActive, page = 1, pageSize = 25, withCounts = false } = params;
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
        ...(withCounts ? { include: { _count: { select: { locations: true, leads: true, jobs: true } } } } : {}),
        orderBy: [{ updatedAt: "desc" }],
        take: Math.min(pageSize, 100),
        skip: (page - 1) * Math.min(pageSize, 100),
      });
    },

    async listWithLocations(params = {}) {
      return prisma.customer.findMany({
        where: { ...tenant, isActive: params.isActive },
        include: { locations: { orderBy: [{ label: "asc" }, { createdAt: "asc" }] } },
        orderBy: [{ companyName: "asc" }, { lastName: "asc" }, { firstName: "asc" }],
        take: 100,
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

    async getDetail(id) {
      return prisma.customer.findFirst({
        where: { id, ...tenant },
        include: {
          locations: { orderBy: [{ label: "asc" }, { createdAt: "asc" }] },
          _count: { select: { jobs: true, leads: true, locations: true } },
        },
      });
    },

    async findByEmailOrPhone(email, phone) {
      if (!email?.trim() && !phone?.trim()) return [];
      return prisma.customer.findMany({
        where: {
          ...tenant,
          isActive: true,
          OR: [
            ...(email?.trim() ? [{ email: { equals: email.trim(), mode: "insensitive" } as const }] : []),
            ...(phone?.trim() ? [{ phone: { equals: phone.trim() } }] : []),
          ],
        },
        take: 10,
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

    async setActive(id, isActive) {
      return prisma.customer.update({
        where: { id_organizationId: { id, organizationId } },
        data: { isActive },
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
