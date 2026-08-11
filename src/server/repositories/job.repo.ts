/**
 * Tenant-scoped Job repository (Phase 1 Slice 5 foundation).
 *
 * Required customer/location relationships are checked inside the tenant and a
 * location must belong to the selected customer. Job's required compound FKs
 * provide a second database-level tenant backstop; the optional Lead FK is
 * id-only, so it is explicitly tenant-checked here.
 *
 * Job-number allocation uses a PostgreSQL transaction advisory lock. When this
 * repository is composed from the global Prisma client, create() opens its own
 * transaction; when it is composed from an existing transaction (as the job
 * actions do for audit atomicity), it participates in that transaction.
 */
import { Prisma, type Customer, type Job, type JobPriority, type JobStatus, type JobType, type Lead, type Location, type PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";

type Client = Prisma.TransactionClient | PrismaClient;

export interface JobCreateData {
  customerId: string;
  locationId: string;
  leadId?: string | null;
  type: JobType;
  priority?: JobPriority;
  title: string;
  description?: string | null;
  quotedAmountCents?: number | null;
  subtotalCents?: number;
  taxCents?: number;
  totalCents?: number;
  actualRevenueCents?: number | null;
}

/** Status/timestamps are deliberately excluded; use updateStatus instead. */
export type JobUpdateData = Partial<JobCreateData>;

export interface JobStatusUpdateData {
  status: JobStatus;
  completedAt?: Date;
  cancelledAt?: Date;
}

export interface JobListParams {
  status?: JobStatus;
  priority?: JobPriority;
  customerId?: string;
  page?: number;
  pageSize?: number;
}

/** Relation data intentionally limited to what the Jobs UI needs. */
export interface JobListItem extends Job {
  customer: Pick<Customer, "id" | "firstName" | "lastName" | "companyName">;
  location: Pick<Location, "id" | "label" | "address1" | "city" | "state" | "postalCode">;
}

export interface JobDetail extends JobListItem {
  lead: Pick<Lead, "id" | "title"> | null;
}

export interface JobRepo {
  list(params?: JobListParams): Promise<JobListItem[]>;
  count(params?: Omit<JobListParams, "page" | "pageSize">): Promise<number>;
  getById(id: string): Promise<Job | null>;
  getDetail(id: string): Promise<JobDetail | null>;
  /** Allocate the next tenant-local job number atomically and create the job. */
  create(data: JobCreateData): Promise<Job>;
  /** Validate the final customer/location/lead tuple before a tenant-scoped update. */
  update(id: string, data: JobUpdateData): Promise<Job>;
  /**
   * Persist only a server-computed lifecycle status/timestamp update. The
   * expected status prevents a stale action from overwriting a concurrent
   * transition after it has been validated.
   */
  updateStatus(id: string, expectedStatus: JobStatus, data: JobStatusUpdateData): Promise<Job>;
}

function isPrismaClient(client: Client): client is PrismaClient {
  return "$transaction" in client && typeof client.$transaction === "function";
}

export function createJobRepo(prisma: Client, organizationId: string): JobRepo {
  const tenant = { organizationId } as const;

  async function assertRelations(data: { customerId: string; locationId: string; leadId?: string | null }): Promise<void> {
    const customer = await prisma.customer.findFirst({
      where: { id: data.customerId, ...tenant },
      select: { id: true },
    });
    if (!customer) throw new NotFoundError("The selected customer does not belong to this organization.");

    const location = await prisma.location.findFirst({
      where: { id: data.locationId, ...tenant },
      select: { id: true, customerId: true },
    });
    if (!location) throw new NotFoundError("The selected location does not belong to this organization.");
    if (location.customerId !== data.customerId) {
      throw new NotFoundError("The selected location does not belong to the selected customer.");
    }

    if (data.leadId) {
      const lead = await prisma.lead.findFirst({ where: { id: data.leadId, ...tenant }, select: { id: true } });
      if (!lead) throw new NotFoundError("The selected lead does not belong to this organization.");
    }
  }

  async function createInTransaction(data: JobCreateData): Promise<Job> {
    await assertRelations(data);
    // This transaction-scoped lock covers both MAX+1 allocation and INSERT.
    // hashtext gives a deterministic per-org key; a collision can only serialize
    // unrelated tenants, never violate the tenant-local unique invariant.
    await prisma.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
    const latest = await prisma.job.findFirst({
      where: tenant,
      orderBy: { jobNumber: "desc" },
      select: { jobNumber: true },
    });
    const jobNumber = (latest?.jobNumber ?? 0) + 1;
    return prisma.job.create({
      data: {
        ...tenant,
        ...data,
        jobNumber,
        status: "DRAFT",
        priority: data.priority ?? "NORMAL",
        subtotalCents: data.subtotalCents ?? 0,
        taxCents: data.taxCents ?? 0,
        totalCents: data.totalCents ?? 0,
      },
    });
  }

  return {
    async list(params = {}) {
      const { status, priority, customerId, page = 1, pageSize = 25 } = params;
      const safePage = Math.max(1, page);
      const safePageSize = Math.max(1, Math.min(pageSize, 100));
      return prisma.job.findMany({
        where: { ...tenant, status, priority, customerId },
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
          location: { select: { id: true, label: true, address1: true, city: true, state: true, postalCode: true } },
        },
        orderBy: [{ updatedAt: "desc" }],
        take: safePageSize,
        skip: (safePage - 1) * safePageSize,
      });
    },

    async count(params = {}) {
      return prisma.job.count({ where: { ...tenant, status: params.status, priority: params.priority, customerId: params.customerId } });
    },

    async getById(id) {
      return prisma.job.findFirst({ where: { id, ...tenant } });
    },

    async getDetail(id) {
      return prisma.job.findFirst({
        where: { id, ...tenant },
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, companyName: true } },
          location: { select: { id: true, label: true, address1: true, city: true, state: true, postalCode: true } },
          lead: { select: { id: true, title: true } },
        },
      });
    },

    async create(data) {
      // A direct repository consumer still gets a real transaction. Job actions
      // pass their audit transaction and therefore share this same atomic unit.
      if (isPrismaClient(prisma)) {
        return prisma.$transaction((tx) => createJobRepo(tx, organizationId).create(data));
      }
      return createInTransaction(data);
    },

    async update(id, data) {
      const existing = await prisma.job.findFirst({ where: { id, ...tenant } });
      if (!existing) throw new NotFoundError("Job not found in this organization.");

      const customerId = data.customerId ?? existing.customerId;
      const locationId = data.locationId ?? existing.locationId;
      const leadId = data.leadId === undefined ? existing.leadId : data.leadId;
      await assertRelations({ customerId, locationId, leadId });

      return prisma.job.update({
        where: { id_organizationId: { id, organizationId } },
        data,
      });
    },

    async updateStatus(id, expectedStatus, data) {
      const update = await prisma.job.updateMany({
        where: { id, ...tenant, status: expectedStatus },
        data: {
          status: data.status,
          ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
          ...(data.cancelledAt !== undefined ? { cancelledAt: data.cancelledAt } : {}),
        },
      });
      if (update.count === 0) {
        const current = await prisma.job.findFirst({ where: { id, ...tenant }, select: { status: true } });
        if (!current) throw new NotFoundError("Job not found in this organization.");
        throw new ConflictError("Job status changed before this transition could be applied. Refresh and try again.");
      }
      const updated = await prisma.job.findFirst({ where: { id, ...tenant } });
      if (!updated) throw new NotFoundError("Job not found in this organization.");
      return updated;
    },
  };
}
