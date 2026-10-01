/**
 * Tenant-scoped Invoice repository. Every query carries the organizationId
 * predicate; cross-tenant customer/job links are rejected before any write.
 *
 * Money rules (design §3 — integer cents, server-authoritative):
 * - `totalCents = subtotalCents + taxCents` and
 *   `balanceCents = totalCents − paidCents` are computed HERE, never accepted
 *   from the browser. Update payloads pick only customer/job/dates/subtotal/tax;
 *   status, paidCents, paidAt and invoiceNumber are not updateable through this
 *   method.
 * - `paidCents` stays untouched until payments land (Slice P2-3); balances are
 *   recomputed against the row's current paidCents on every write.
 * - `invoiceNumber` is allocated org-locally under the per-org advisory lock
 *   (`pg_advisory_xact_lock(hashtext(orgId))`) inside the create transaction.
 *   It uses $executeRaw, NOT $queryRaw: the lock returns `void` and $queryRaw
 *   fails to deserialize a void column against live Postgres (commit ff04182).
 *
 * Status writes go through the pure transition map in
 * src/server/domain/invoice-status.ts; OVERDUE is derived on read and is not a
 * valid transition target.
 */
import {
  Prisma,
  type Customer,
  type Invoice,
  type InvoiceStatus,
  type Job,
  type PrismaClient,
} from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { applyInvoiceStatusTransition, type InvoiceTransitionFields } from "@/server/domain/invoice-status";

type Client = Prisma.TransactionClient | PrismaClient;

export interface InvoiceCreateData {
  customerId: string;
  jobId?: string | null;
  issuedAt?: Date | null;
  dueAt?: Date | null;
  subtotalCents?: number;
  taxCents?: number;
}
export type InvoiceUpdateData = Partial<InvoiceCreateData>;
export interface InvoiceListParams {
  status?: InvoiceStatus;
  customerId?: string;
  /** Free text: matches the invoice number (when numeric) or the customer name. */
  search?: string;
  issuedFrom?: Date;
  issuedTo?: Date;
  dueFrom?: Date;
  dueTo?: Date;
  page?: number;
  pageSize?: number;
}
export interface InvoiceListItem extends Invoice {
  customer: Pick<Customer, "id" | "firstName" | "lastName" | "companyName">;
}
export interface InvoiceDetail extends InvoiceListItem {
  job: Pick<Job, "id" | "jobNumber" | "title"> | null;
}
export interface InvoiceRepo {
  list(params?: InvoiceListParams): Promise<InvoiceListItem[]>;
  count(params?: Omit<InvoiceListParams, "page" | "pageSize">): Promise<number>;
  getById(id: string): Promise<Invoice | null>;
  getDetail(id: string): Promise<InvoiceDetail | null>;
  create(data: InvoiceCreateData): Promise<Invoice>;
  update(id: string, data: InvoiceUpdateData): Promise<Invoice>;
  /** Server-enforced transition; the only caller that writes Invoice.status. */
  setStatus(id: string, to: InvoiceStatus, options?: { now?: Date }): Promise<Invoice>;
}

const customerSelect = { id: true, firstName: true, lastName: true, companyName: true } as const;
const jobSelect = { id: true, jobNumber: true, title: true } as const;

/** Server-side cents recompute — the single place totals are derived. */
export function recomputeInvoiceTotals(
  subtotalCents: number,
  taxCents: number,
  paidCents: number,
): { totalCents: number; balanceCents: number } {
  const totalCents = subtotalCents + taxCents;
  return { totalCents, balanceCents: totalCents - paidCents };
}

/** Builds the tenant-scoped where predicate shared by list/count (pure → tested). */
export function invoiceListWhere(
  organizationId: string,
  params: InvoiceListParams = {},
): Prisma.InvoiceWhereInput {
  const search = params.search?.trim();
  const searchNumber = search ? Number.parseInt(search, 10) : NaN;
  return {
    organizationId,
    ...(params.status ? { status: params.status } : {}),
    ...(params.customerId ? { customerId: params.customerId } : {}),
    ...(params.issuedFrom || params.issuedTo
      ? { issuedAt: { ...(params.issuedFrom ? { gte: params.issuedFrom } : {}), ...(params.issuedTo ? { lte: params.issuedTo } : {}) } }
      : {}),
    ...(params.dueFrom || params.dueTo
      ? { dueAt: { ...(params.dueFrom ? { gte: params.dueFrom } : {}), ...(params.dueTo ? { lte: params.dueTo } : {}) } }
      : {}),
    ...(search
      ? {
          OR: [
            // A numeric query matches the invoice number exactly; text falls
            // through to the customer's name fields.
            ...(Number.isSafeInteger(searchNumber) ? [{ invoiceNumber: searchNumber }] : []),
            { customer: { is: { OR: [{ firstName: { contains: search, mode: "insensitive" } }, { lastName: { contains: search, mode: "insensitive" } }, { companyName: { contains: search, mode: "insensitive" } }] } } },
          ],
        }
      : {}),
  };
}

function isPrismaClient(client: Client): client is PrismaClient {
  return "$transaction" in client && typeof client.$transaction === "function";
}

export function createInvoiceRepo(prisma: Client, organizationId: string): InvoiceRepo {
  const tenant = { organizationId } as const;

  async function assertCustomer(customerId: string): Promise<void> {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, ...tenant }, select: { id: true } });
    if (!customer) throw new NotFoundError("The selected customer does not belong to this organization.");
  }
  async function assertJob(jobId: string): Promise<void> {
    const job = await prisma.job.findFirst({ where: { id: jobId, ...tenant }, select: { id: true } });
    if (!job) throw new NotFoundError("The selected job does not belong to this organization.");
  }

  async function createInTransaction(data: InvoiceCreateData): Promise<Invoice> {
    await assertCustomer(data.customerId);
    if (data.jobId) await assertJob(data.jobId);
    // Org-local invoice number under the per-org advisory lock. See file
    // header: $executeRaw, never $queryRaw, for the void-column lock.
    await prisma.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
    const latest = await prisma.invoice.findFirst({ where: tenant, orderBy: { invoiceNumber: "desc" }, select: { invoiceNumber: true } });
    const subtotalCents = data.subtotalCents ?? 0;
    const taxCents = data.taxCents ?? 0;
    // paidCents is not client-settable; a fresh invoice is always unpaid, so
    // balanceCents === totalCents at creation.
    const { totalCents, balanceCents } = recomputeInvoiceTotals(subtotalCents, taxCents, 0);
    return prisma.invoice.create({
      data: {
        ...tenant,
        customerId: data.customerId,
        ...(data.jobId !== undefined && data.jobId !== null ? { jobId: data.jobId } : {}),
        ...(data.issuedAt !== undefined ? { issuedAt: data.issuedAt } : {}),
        ...(data.dueAt !== undefined ? { dueAt: data.dueAt } : {}),
        subtotalCents,
        taxCents,
        totalCents,
        balanceCents,
        invoiceNumber: (latest?.invoiceNumber ?? 0) + 1,
        status: "DRAFT",
      },
    });
  }

  async function setStatusInTransaction(id: string, to: InvoiceStatus, options?: { now?: Date }): Promise<Invoice> {
    const existing = await prisma.invoice.findFirst({ where: { id, ...tenant } });
    if (!existing) throw new NotFoundError("Invoice not found in this organization.");
    if (existing.status === to) return existing; // Same-status request is a no-op.
    const fields = applyInvoiceStatusTransition(
      existing.status,
      to,
      { balanceCents: existing.balanceCents, paidCents: existing.paidCents },
      options,
    );
    // Optimistic guard on the observed status; count 0 means a concurrent write
    // moved the invoice first (or the row vanished) — never a silent overwrite.
    const update = await prisma.invoice.updateMany({
      where: { id, ...tenant, status: existing.status },
      data: { status: to, ...invoiceTransitionData(fields) },
    });
    if (update.count === 0) {
      throw new ConflictError("Invoice status changed before this transition could be applied. Refresh and try again.");
    }
    const updated = await prisma.invoice.findFirst({ where: { id, ...tenant } });
    if (!updated) throw new NotFoundError("Invoice not found in this organization.");
    return updated;
  }

  return {
    async list(params = {}) {
      const { page = 1, pageSize = 25 } = params;
      const size = Math.max(1, Math.min(pageSize, 100));
      return prisma.invoice.findMany({
        where: invoiceListWhere(organizationId, params),
        include: { customer: { select: customerSelect } },
        orderBy: [{ invoiceNumber: "desc" }],
        take: size,
        skip: (Math.max(1, page) - 1) * size,
      });
    },
    async count(params = {}) {
      return prisma.invoice.count({ where: invoiceListWhere(organizationId, params) });
    },
    async getById(id) {
      return prisma.invoice.findFirst({ where: { id, ...tenant } });
    },
    async getDetail(id) {
      return prisma.invoice.findFirst({
        where: { id, ...tenant },
        include: { customer: { select: customerSelect }, job: { select: jobSelect } },
      });
    },
    async create(data) {
      return isPrismaClient(prisma)
        ? prisma.$transaction((tx) => createInvoiceRepo(tx, organizationId).create(data))
        : createInTransaction(data);
    },
    async update(id, data) {
      const existing = await prisma.invoice.findFirst({ where: { id, ...tenant } });
      if (!existing) throw new NotFoundError("Invoice not found in this organization.");
      if (data.customerId !== undefined) await assertCustomer(data.customerId);
      if (data.jobId) await assertJob(data.jobId);
      const subtotalCents = data.subtotalCents ?? existing.subtotalCents;
      const taxCents = data.taxCents ?? existing.taxCents;
      // Recompute against the CURRENT paidCents — the browser never sends money
      // totals, balances, or payment state through this path.
      const money = recomputeInvoiceTotals(subtotalCents, taxCents, existing.paidCents);
      // updateMany carries BOTH predicates in the where (no compound
      // id_organizationId unique selector on this model): the write itself is
      // tenant-scoped even if the row moved between the pre-check and here.
      const update = await prisma.invoice.updateMany({
        where: { id, ...tenant },
        data: {
          ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
          ...(data.jobId !== undefined ? { jobId: data.jobId } : {}),
          ...(data.issuedAt !== undefined ? { issuedAt: data.issuedAt } : {}),
          ...(data.dueAt !== undefined ? { dueAt: data.dueAt } : {}),
          subtotalCents,
          taxCents,
          totalCents: money.totalCents,
          balanceCents: money.balanceCents,
        },
      });
      if (update.count === 0) throw new NotFoundError("Invoice not found in this organization.");
      const updated = await prisma.invoice.findFirst({ where: { id, ...tenant } });
      if (!updated) throw new NotFoundError("Invoice not found in this organization.");
      return updated;
    },
    async setStatus(id, to, options) {
      return isPrismaClient(prisma)
        ? prisma.$transaction((tx) => createInvoiceRepo(tx, organizationId).setStatus(id, to, options))
        : setStatusInTransaction(id, to, options);
    },
  };
}

function invoiceTransitionData(fields: InvoiceTransitionFields): Prisma.InvoiceUpdateManyMutationInput {
  return fields.paidAt !== undefined ? { paidAt: fields.paidAt } : {};
}
