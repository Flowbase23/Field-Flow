/**
 * Tenant-scoped Estimate repository. Every query carries the organizationId
 * predicate; cross-tenant customer/job links are rejected before any write.
 *
 * Money rules (design §3 — integer cents, server-authoritative):
 * - `totalCents = subtotalCents + taxCents` is computed HERE, never accepted
 *   from the browser. Update payloads pick only customer/job/title/validUntil/
 *   subtotal/tax; status, the lifecycle stamps (sentAt/acceptedAt/declinedAt)
 *   and estimateNumber are not updateable through this method.
 * - `estimateNumber` is allocated org-locally under the per-org advisory lock
 *   (`pg_advisory_xact_lock(hashtext(orgId))`) inside the create transaction.
 *   It uses $executeRaw, NOT $queryRaw: the lock returns `void` and $queryRaw
 *   fails to deserialize a void column against live Postgres (commit ff04182).
 *
 * Status writes go through the pure transition map in
 * src/server/domain/estimate-status.ts; EXPIRED is derived on read and is not a
 * valid transition target (it maps to a SENT+past-validUntil list filter).
 */
import {
  Prisma,
  type Customer,
  type Estimate,
  type EstimateStatus,
  type Job,
  type PrismaClient,
} from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { generatePortalToken } from "@/server/domain/portal-token";
import {
  applyEstimateStatusTransition,
  type EstimateDisplayStatus,
  type EstimateTransitionFields,
} from "@/server/domain/estimate-status";

type Client = Prisma.TransactionClient | PrismaClient;

export interface EstimateCreateData {
  customerId: string;
  jobId?: string | null;
  title?: string | null;
  validUntil?: Date | null;
  subtotalCents?: number;
  taxCents?: number;
}
export type EstimateUpdateData = Partial<EstimateCreateData>;
export interface EstimateListParams {
  status?: EstimateDisplayStatus;
  customerId?: string;
  /** Free text: matches the estimate number (when numeric), the title, or the customer name. */
  search?: string;
  validFrom?: Date;
  validUntilBefore?: Date;
  page?: number;
  pageSize?: number;
}
export interface EstimateListItem extends Estimate {
  customer: Pick<Customer, "id" | "firstName" | "lastName" | "companyName">;
}
export interface EstimateDetail extends EstimateListItem {
  job: Pick<Job, "id" | "jobNumber" | "title"> | null;
  /**
   * The job this estimate was CONVERTED into (Job.estimateId marker), if any.
   * Distinct from `job` above, which is the user-settable "Linked job"
   * association: a conversion sets both, but only `convertedJob` proves a
   * conversion happened (a user can link an estimate to a job by hand).
   */
  convertedJob: Pick<Job, "id" | "jobNumber" | "title"> | null;
}
export interface EstimateRepo {
  list(params?: EstimateListParams): Promise<EstimateListItem[]>;
  count(params?: Omit<EstimateListParams, "page" | "pageSize">): Promise<number>;
  getById(id: string): Promise<Estimate | null>;
  getDetail(id: string): Promise<EstimateDetail | null>;
  create(data: EstimateCreateData): Promise<Estimate>;
  update(id: string, data: EstimateUpdateData): Promise<Estimate>;
  /** Server-enforced transition; the only caller that writes Estimate.status. */
  setStatus(id: string, to: EstimateStatus, options?: { now?: Date }): Promise<Estimate>;
  /**
   * Customer-portal token (P2-S4): generated once on demand, then stable, so
   * copied links keep working. `generated` reports whether THIS call created
   * the token (the only case the caller audits).
   */
  ensurePortalToken(id: string): Promise<{ estimate: Estimate; generated: boolean }>;
}

const customerSelect = { id: true, firstName: true, lastName: true, companyName: true } as const;
const jobSelect = { id: true, jobNumber: true, title: true } as const;

/** Server-side cents recompute — the single place the total is derived. */
export function recomputeEstimateTotals(
  subtotalCents: number,
  taxCents: number,
): { totalCents: number } {
  return { totalCents: subtotalCents + taxCents };
}

/** Builds the tenant-scoped where predicate shared by list/count (pure → tested). */
export function estimateListWhere(
  organizationId: string,
  params: EstimateListParams = {},
  now: Date = new Date(),
): Prisma.EstimateWhereInput {
  const search = params.search?.trim();
  const searchNumber = search ? Number.parseInt(search, 10) : NaN;
  const validityFilter = params.validFrom || params.validUntilBefore
    ? {
        validUntil: {
          ...(params.validFrom ? { gte: params.validFrom } : {}),
          ...(params.validUntilBefore ? { lte: params.validUntilBefore } : {}),
        },
      }
    : {};
  return {
    organizationId,
    // EXPIRED is derived, never persisted: filtering by it selects SENT
    // estimates whose validUntil is in the past.
    ...(params.status === "EXPIRED"
      ? { status: "SENT" as EstimateStatus, validUntil: { lt: now } }
      : params.status
        ? { status: params.status }
        : {}),
    ...(params.customerId ? { customerId: params.customerId } : {}),
    ...validityFilter,
    ...(search
      ? {
          OR: [
            // A numeric query matches the estimate number exactly; text falls
            // through to the title and the customer's name fields.
            ...(Number.isSafeInteger(searchNumber) ? [{ estimateNumber: searchNumber }] : []),
            ...(search ? [{ title: { contains: search, mode: "insensitive" as const } }] : []),
            { customer: { is: { OR: [{ firstName: { contains: search, mode: "insensitive" } }, { lastName: { contains: search, mode: "insensitive" } }, { companyName: { contains: search, mode: "insensitive" } }] } } },
          ],
        }
      : {}),
  };
}

function isPrismaClient(client: Client): client is PrismaClient {
  return "$transaction" in client && typeof client.$transaction === "function";
}

export function createEstimateRepo(prisma: Client, organizationId: string): EstimateRepo {
  const tenant = { organizationId } as const;

  async function assertCustomer(customerId: string): Promise<void> {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, ...tenant }, select: { id: true } });
    if (!customer) throw new NotFoundError("The selected customer does not belong to this organization.");
  }
  async function assertJob(jobId: string): Promise<void> {
    const job = await prisma.job.findFirst({ where: { id: jobId, ...tenant }, select: { id: true } });
    if (!job) throw new NotFoundError("The selected job does not belong to this organization.");
  }

  async function createInTransaction(data: EstimateCreateData): Promise<Estimate> {
    await assertCustomer(data.customerId);
    if (data.jobId) await assertJob(data.jobId);
    // Org-local estimate number under the per-org advisory lock. See file
    // header: $executeRaw, never $queryRaw, for the void-column lock.
    await prisma.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
    const latest = await prisma.estimate.findFirst({ where: tenant, orderBy: { estimateNumber: "desc" }, select: { estimateNumber: true } });
    const subtotalCents = data.subtotalCents ?? 0;
    const taxCents = data.taxCents ?? 0;
    const { totalCents } = recomputeEstimateTotals(subtotalCents, taxCents);
    return prisma.estimate.create({
      data: {
        ...tenant,
        customerId: data.customerId,
        ...(data.jobId !== undefined && data.jobId !== null ? { jobId: data.jobId } : {}),
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.validUntil !== undefined ? { validUntil: data.validUntil } : {}),
        subtotalCents,
        taxCents,
        totalCents,
        estimateNumber: (latest?.estimateNumber ?? 0) + 1,
        status: "DRAFT",
      },
    });
  }

  async function setStatusInTransaction(id: string, to: EstimateStatus, options?: { now?: Date }): Promise<Estimate> {
    const existing = await prisma.estimate.findFirst({ where: { id, ...tenant } });
    if (!existing) throw new NotFoundError("Estimate not found in this organization.");
    if (existing.status === to) return existing; // Same-status request is a no-op.
    const fields = applyEstimateStatusTransition(existing.status, to, options);
    // Optimistic guard on the observed status; count 0 means a concurrent write
    // moved the estimate first (or the row vanished) — never a silent overwrite.
    const update = await prisma.estimate.updateMany({
      where: { id, ...tenant, status: existing.status },
      data: { status: to, ...estimateTransitionData(fields) },
    });
    if (update.count === 0) {
      throw new ConflictError("Estimate status changed before this transition could be applied. Refresh and try again.");
    }
    const updated = await prisma.estimate.findFirst({ where: { id, ...tenant } });
    if (!updated) throw new NotFoundError("Estimate not found in this organization.");
    return updated;
  }

  return {
    async list(params = {}) {
      const { page = 1, pageSize = 25 } = params;
      const size = Math.max(1, Math.min(pageSize, 100));
      return prisma.estimate.findMany({
        where: estimateListWhere(organizationId, params),
        include: { customer: { select: customerSelect } },
        orderBy: [{ estimateNumber: "desc" }],
        take: size,
        skip: (Math.max(1, page) - 1) * size,
      });
    },
    async count(params = {}) {
      return prisma.estimate.count({ where: estimateListWhere(organizationId, params) });
    },
    async getById(id) {
      return prisma.estimate.findFirst({ where: { id, ...tenant } });
    },
    async getDetail(id) {
      const detail = await prisma.estimate.findFirst({
        where: { id, ...tenant },
        include: { customer: { select: customerSelect }, job: { select: jobSelect }, convertedJobs: { select: jobSelect } },
      });
      if (!detail) return null;
      // At most one converted job exists per estimate (compound unique on Job);
      // the include is a list purely because the FK lives on the Job side. The
      // optional chain keeps test fakes that don't model the include total.
      return { ...detail, convertedJob: detail.convertedJobs?.[0] ?? null };
    },
    async create(data) {
      return isPrismaClient(prisma)
        ? prisma.$transaction((tx) => createEstimateRepo(tx, organizationId).create(data))
        : createInTransaction(data);
    },
    async update(id, data) {
      const existing = await prisma.estimate.findFirst({ where: { id, ...tenant } });
      if (!existing) throw new NotFoundError("Estimate not found in this organization.");
      if (data.customerId !== undefined) await assertCustomer(data.customerId);
      if (data.jobId) await assertJob(data.jobId);
      const subtotalCents = data.subtotalCents ?? existing.subtotalCents;
      const taxCents = data.taxCents ?? existing.taxCents;
      // Recompute server-side — the browser never sends money totals here.
      const { totalCents } = recomputeEstimateTotals(subtotalCents, taxCents);
      // updateMany carries BOTH predicates in the where (no compound
      // id_organizationId unique selector on this model): the write itself is
      // tenant-scoped even if the row moved between the pre-check and here.
      const update = await prisma.estimate.updateMany({
        where: { id, ...tenant },
        data: {
          ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
          ...(data.jobId !== undefined ? { jobId: data.jobId } : {}),
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.validUntil !== undefined ? { validUntil: data.validUntil } : {}),
          subtotalCents,
          taxCents,
          totalCents,
        },
      });
      if (update.count === 0) throw new NotFoundError("Estimate not found in this organization.");
      const updated = await prisma.estimate.findFirst({ where: { id, ...tenant } });
      if (!updated) throw new NotFoundError("Estimate not found in this organization.");
      return updated;
    },
    async setStatus(id, to, options) {
      return isPrismaClient(prisma)
        ? prisma.$transaction((tx) => createEstimateRepo(tx, organizationId).setStatus(id, to, options))
        : setStatusInTransaction(id, to, options);
    },
    async ensurePortalToken(id) {
      const existing = await prisma.estimate.findFirst({ where: { id, ...tenant } });
      if (!existing) throw new NotFoundError("Estimate not found in this organization.");
      if (existing.portalToken) return { estimate: existing, generated: false };
      // Guarded first-write: only succeeds when the token is still NULL. On a
      // concurrent race the loser re-reads and returns the winner's token, so
      // every caller observes the same (stable) value.
      const update = await prisma.estimate.updateMany({
        where: { id, ...tenant, portalToken: null },
        data: { portalToken: generatePortalToken() },
      });
      const updated = await prisma.estimate.findFirst({ where: { id, ...tenant } });
      if (!updated || !updated.portalToken) throw new NotFoundError("Estimate not found in this organization.");
      return { estimate: updated, generated: update.count > 0 };
    },
  };
}

function estimateTransitionData(fields: EstimateTransitionFields): Prisma.EstimateUpdateManyMutationInput {
  const data: Prisma.EstimateUpdateManyMutationInput = {};
  if (fields.sentAt !== undefined) data.sentAt = fields.sentAt;
  if (fields.acceptedAt !== undefined) data.acceptedAt = fields.acceptedAt;
  if (fields.declinedAt !== undefined) data.declinedAt = fields.declinedAt;
  return data;
}
