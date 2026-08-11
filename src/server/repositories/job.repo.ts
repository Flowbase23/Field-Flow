/**
 * Tenant-scoped Job repository. Customer/location and optional lead links are
 * verified in the org before writes. Dispatch joins use the same scope and keep
 * the zero-or-one-primary invariant inside a transaction.
 */
import {
  Prisma,
  type Customer,
  type Job,
  type JobPriority,
  type JobStatus,
  type JobType,
  type Lead,
  type Location,
  type PrismaClient,
  type Technician,
  type User,
} from "@prisma/client";
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
export type JobUpdateData = Partial<JobCreateData>;
export interface JobStatusUpdateData { status: JobStatus; completedAt?: Date; cancelledAt?: Date; }
export interface JobListParams { status?: JobStatus; priority?: JobPriority; customerId?: string; page?: number; pageSize?: number; }
export interface JobListItem extends Job {
  customer: Pick<Customer, "id" | "firstName" | "lastName" | "companyName">;
  location: Pick<Location, "id" | "label" | "address1" | "city" | "state" | "postalCode">;
}
export interface JobTechnicianSummary {
  technicianId: string;
  isPrimary: boolean;
  assignedAt: Date;
  technician: Pick<Technician, "id" | "isActive" | "employeeCode"> & {
    user: Pick<User, "id" | "firstName" | "lastName" | "email">;
  };
}
export interface JobDetail extends JobListItem {
  lead: Pick<Lead, "id" | "title"> | null;
  technicians: JobTechnicianSummary[];
}
export interface EligibleJobTechnician extends Pick<Technician, "id" | "isActive" | "employeeCode"> {
  user: Pick<User, "id" | "firstName" | "lastName" | "email">;
}
export interface JobRepo {
  list(params?: JobListParams): Promise<JobListItem[]>;
  count(params?: Omit<JobListParams, "page" | "pageSize">): Promise<number>;
  getById(id: string): Promise<Job | null>;
  getDetail(id: string): Promise<JobDetail | null>;
  /** Active tenant technicians eligible for assignment. */
  listEligibleTechnicians(): Promise<EligibleJobTechnician[]>;
  create(data: JobCreateData): Promise<Job>;
  update(id: string, data: JobUpdateData): Promise<Job>;
  updateStatus(id: string, expectedStatus: JobStatus, data: JobStatusUpdateData): Promise<Job>;
  /** Creates/updates an assignment. A primary assignment atomically demotes any prior primary. */
  assignTechnician(jobId: string, technicianId: string, isPrimary?: boolean): Promise<void>;
  /** Deletes the join; a deleted primary cannot remain primary. */
  unassignTechnician(jobId: string, technicianId: string): Promise<void>;
  /** Promotes an existing assignment while atomically demoting the prior primary. */
  setPrimaryTechnician(jobId: string, technicianId: string): Promise<void>;
}

const technicianUserSelect = { id: true, firstName: true, lastName: true, email: true } as const;
function isPrismaClient(client: Client): client is PrismaClient {
  return "$transaction" in client && typeof client.$transaction === "function";
}

export function createJobRepo(prisma: Client, organizationId: string): JobRepo {
  const tenant = { organizationId } as const;

  async function assertRelations(data: { customerId: string; locationId: string; leadId?: string | null }): Promise<void> {
    const customer = await prisma.customer.findFirst({ where: { id: data.customerId, ...tenant }, select: { id: true } });
    if (!customer) throw new NotFoundError("The selected customer does not belong to this organization.");
    const location = await prisma.location.findFirst({ where: { id: data.locationId, ...tenant }, select: { id: true, customerId: true } });
    if (!location) throw new NotFoundError("The selected location does not belong to this organization.");
    if (location.customerId !== data.customerId) throw new NotFoundError("The selected location does not belong to the selected customer.");
    if (data.leadId) {
      const lead = await prisma.lead.findFirst({ where: { id: data.leadId, ...tenant }, select: { id: true } });
      if (!lead) throw new NotFoundError("The selected lead does not belong to this organization.");
    }
  }

  async function assertJob(jobId: string): Promise<void> {
    const job = await prisma.job.findFirst({ where: { id: jobId, ...tenant }, select: { id: true } });
    if (!job) throw new NotFoundError("Job not found in this organization.");
  }
  async function assertTechnician(technicianId: string, activeRequired: boolean): Promise<void> {
    const technician = await prisma.technician.findFirst({ where: { id: technicianId, ...tenant }, select: { id: true, isActive: true } });
    if (!technician || (activeRequired && !technician.isActive)) {
      throw new NotFoundError("The selected technician is not active in this organization.");
    }
  }

  async function createInTransaction(data: JobCreateData): Promise<Job> {
    await assertRelations(data);
    await prisma.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
    const latest = await prisma.job.findFirst({ where: tenant, orderBy: { jobNumber: "desc" }, select: { jobNumber: true } });
    return prisma.job.create({ data: { ...tenant, ...data, jobNumber: (latest?.jobNumber ?? 0) + 1, status: "DRAFT", priority: data.priority ?? "NORMAL", subtotalCents: data.subtotalCents ?? 0, taxCents: data.taxCents ?? 0, totalCents: data.totalCents ?? 0 } });
  }

  async function assignInTransaction(jobId: string, technicianId: string, isPrimary: boolean): Promise<void> {
    await assertJob(jobId);
    await assertTechnician(technicianId, true);
    if (isPrimary) await prisma.jobTechnician.updateMany({ where: { jobId, ...tenant, isPrimary: true }, data: { isPrimary: false } });
    await prisma.jobTechnician.upsert({
      where: { jobId_technicianId: { jobId, technicianId } },
      create: { jobId, technicianId, organizationId, isPrimary },
      update: { isPrimary },
    });
  }
  async function unassignInTransaction(jobId: string, technicianId: string): Promise<void> {
    await assertJob(jobId);
    // Inactive technicians may be removed, but off-tenant ids are always rejected.
    await assertTechnician(technicianId, false);
    await prisma.jobTechnician.deleteMany({ where: { jobId, technicianId, ...tenant } });
  }
  async function primaryInTransaction(jobId: string, technicianId: string): Promise<void> {
    await assertJob(jobId);
    await assertTechnician(technicianId, false);
    const assignment = await prisma.jobTechnician.findFirst({ where: { jobId, technicianId, ...tenant }, select: { technicianId: true } });
    if (!assignment) throw new NotFoundError("Technician must be assigned before they can be primary.");
    await prisma.jobTechnician.updateMany({ where: { jobId, ...tenant, isPrimary: true }, data: { isPrimary: false } });
    await prisma.jobTechnician.update({ where: { jobId_technicianId: { jobId, technicianId } }, data: { isPrimary: true } });
  }

  return {
    async list(params = {}) {
      const { status, priority, customerId, page = 1, pageSize = 25 } = params;
      return prisma.job.findMany({ where: { ...tenant, status, priority, customerId }, include: { customer: { select: { id: true, firstName: true, lastName: true, companyName: true } }, location: { select: { id: true, label: true, address1: true, city: true, state: true, postalCode: true } } }, orderBy: [{ updatedAt: "desc" }], take: Math.max(1, Math.min(pageSize, 100)), skip: (Math.max(1, page) - 1) * Math.max(1, Math.min(pageSize, 100)) });
    },
    async count(params = {}) { return prisma.job.count({ where: { ...tenant, status: params.status, priority: params.priority, customerId: params.customerId } }); },
    async getById(id) { return prisma.job.findFirst({ where: { id, ...tenant } }); },
    async getDetail(id) {
      return prisma.job.findFirst({ where: { id, ...tenant }, include: { customer: { select: { id: true, firstName: true, lastName: true, companyName: true } }, location: { select: { id: true, label: true, address1: true, city: true, state: true, postalCode: true } }, lead: { select: { id: true, title: true } }, technicians: { include: { technician: { select: { id: true, isActive: true, employeeCode: true, user: { select: technicianUserSelect } } } }, orderBy: [{ isPrimary: "desc" }, { assignedAt: "asc" }] } } });
    },
    async listEligibleTechnicians() {
      return prisma.technician.findMany({ where: { ...tenant, isActive: true }, select: { id: true, isActive: true, employeeCode: true, user: { select: technicianUserSelect } }, orderBy: [{ user: { firstName: "asc" } }, { user: { lastName: "asc" } }] });
    },
    async create(data) { return isPrismaClient(prisma) ? prisma.$transaction((tx) => createJobRepo(tx, organizationId).create(data)) : createInTransaction(data); },
    async update(id, data) {
      const existing = await prisma.job.findFirst({ where: { id, ...tenant } });
      if (!existing) throw new NotFoundError("Job not found in this organization.");
      await assertRelations({ customerId: data.customerId ?? existing.customerId, locationId: data.locationId ?? existing.locationId, leadId: data.leadId === undefined ? existing.leadId : data.leadId });
      return prisma.job.update({ where: { id_organizationId: { id, organizationId } }, data });
    },
    async updateStatus(id, expectedStatus, data) {
      const update = await prisma.job.updateMany({ where: { id, ...tenant, status: expectedStatus }, data: { status: data.status, ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}), ...(data.cancelledAt !== undefined ? { cancelledAt: data.cancelledAt } : {}) } });
      if (update.count === 0) {
        const current = await prisma.job.findFirst({ where: { id, ...tenant }, select: { status: true } });
        if (!current) throw new NotFoundError("Job not found in this organization.");
        throw new ConflictError("Job status changed before this transition could be applied. Refresh and try again.");
      }
      const updated = await prisma.job.findFirst({ where: { id, ...tenant } });
      if (!updated) throw new NotFoundError("Job not found in this organization.");
      return updated;
    },
    async assignTechnician(jobId, technicianId, isPrimary = false) { return isPrismaClient(prisma) ? prisma.$transaction((tx) => createJobRepo(tx, organizationId).assignTechnician(jobId, technicianId, isPrimary)) : assignInTransaction(jobId, technicianId, isPrimary); },
    async unassignTechnician(jobId, technicianId) { return isPrismaClient(prisma) ? prisma.$transaction((tx) => createJobRepo(tx, organizationId).unassignTechnician(jobId, technicianId)) : unassignInTransaction(jobId, technicianId); },
    async setPrimaryTechnician(jobId, technicianId) { return isPrismaClient(prisma) ? prisma.$transaction((tx) => createJobRepo(tx, organizationId).setPrimaryTechnician(jobId, technicianId)) : primaryInTransaction(jobId, technicianId); },
  };
}
