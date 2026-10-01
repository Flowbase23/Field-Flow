/** Invoice repository guard tests use a small Prisma-shaped fake at the repo seam. */
import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { createInvoiceRepo, invoiceListWhere, recomputeInvoiceTotals } from "@/server/repositories/invoice.repo";

const ORG_A = "org-a";
const ORG_B = "org-b";
const NOW = new Date("2026-10-01T15:00:00.000Z");
const CUID = "cjld93cjlb000000c4bmu1jn";

type Row = Record<string, any>;
function makePrisma() {
  const customers = [
    { id: "customer-a", organizationId: ORG_A },
    { id: "customer-b", organizationId: ORG_B },
  ];
  const jobs = [
    { id: "job-a", organizationId: ORG_A },
    { id: "job-b", organizationId: ORG_B },
  ];
  const invoices: Row[] = [
    { id: "inv-a1", organizationId: ORG_A, invoiceNumber: 4, customerId: "customer-a", jobId: null, status: "SENT", issuedAt: null, dueAt: null, paidAt: null, subtotalCents: 10000, taxCents: 800, totalCents: 10800, paidCents: 0, balanceCents: 10800 },
    { id: "inv-a2", organizationId: ORG_A, invoiceNumber: 7, customerId: "customer-a", jobId: "job-a", status: "PARTIALLY_PAID", issuedAt: null, dueAt: null, paidAt: null, subtotalCents: 5000, taxCents: 0, totalCents: 5000, paidCents: 2000, balanceCents: 3000 },
    { id: "inv-b1", organizationId: ORG_B, invoiceNumber: 99, customerId: "customer-b", jobId: "job-b", status: "SENT", issuedAt: null, dueAt: null, paidAt: null, subtotalCents: 1, taxCents: 0, totalCents: 1, paidCents: 0, balanceCents: 1 },
  ];
  const locks = vi.fn().mockResolvedValue([]);
  function match(where: any): Row[] {
    return invoices.filter((row) => {
      if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
      if (where.id !== undefined && row.id !== where.id) return false;
      if (where.customerId !== undefined && row.customerId !== where.customerId) return false;
      if (where.status !== undefined && row.status !== where.status) return false;
      return true;
    });
  }
  const prisma = {
    $executeRaw: locks,
    $transaction: undefined as unknown,
    customer: { findFirst: vi.fn(async ({ where }: any) => customers.find((row) => row.id === where.id && row.organizationId === where.organizationId) ?? null) },
    job: { findFirst: vi.fn(async ({ where }: any) => jobs.find((row) => row.id === where.id && row.organizationId === where.organizationId) ?? null) },
    invoice: {
      findFirst: vi.fn(async ({ where, orderBy, select }: any) => {
        const matches = match(where);
        const row = orderBy?.invoiceNumber === "desc"
          ? [...matches].sort((a, b) => Number(b.invoiceNumber) - Number(a.invoiceNumber))[0]
          : matches[0];
        if (!row) return null;
        return select?.invoiceNumber ? { invoiceNumber: row.invoiceNumber } : { ...row };
      }),
      findMany: vi.fn(async ({ where, orderBy, take = 25, skip = 0 }: any) => {
        let rows = match(where);
        if (orderBy?.[0]?.invoiceNumber === "desc") rows = [...rows].sort((a, b) => Number(b.invoiceNumber) - Number(a.invoiceNumber));
        return rows.slice(skip, skip + take).map((row) => ({
          ...row,
          customer: { id: "customer-x", firstName: "A", lastName: "B", companyName: null },
        }));
      }),
      count: vi.fn(async ({ where }: any) => match(where).length),
      create: vi.fn(async ({ data }: any) => {
        const created = { id: `inv-${invoices.length + 1}`, paidCents: 0, paidAt: null, ...data };
        invoices.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = invoices.find((invoice) => invoice.id === where.id_organizationId.id && invoice.organizationId === where.id_organizationId.organizationId);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = invoices.find((invoice) => invoice.id === where.id && invoice.organizationId === where.organizationId && (where.status === undefined || invoice.status === where.status));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  return { prisma, locks, invoices };
}
const createData = { customerId: "customer-a", subtotalCents: 2500, taxCents: 200 };

describe("Invoice repository tenant guards", () => {
  it("rejects a customer from another tenant before creating", async () => {
    const { prisma } = makePrisma();
    await expect(createInvoiceRepo(prisma as never, ORG_A).create({ ...createData, customerId: "customer-b" })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
  it("rejects an optional job link from another tenant", async () => {
    const { prisma } = makePrisma();
    await expect(createInvoiceRepo(prisma as never, ORG_A).create({ ...createData, jobId: "job-b" })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });
  it("rejects cross-tenant ids on reads and updates", async () => {
    const { prisma } = makePrisma();
    expect(await createInvoiceRepo(prisma as never, ORG_A).getById("inv-b1")).toBeNull();
    await expect(createInvoiceRepo(prisma as never, ORG_A).getDetail("inv-b1")).resolves.toBeNull();
    await expect(createInvoiceRepo(prisma as never, ORG_A).update("inv-b1", { dueAt: NOW })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createInvoiceRepo(prisma as never, ORG_A).setStatus("inv-b1", "VOID")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("re-checks the new customer link on update before writing", async () => {
    const { prisma } = makePrisma();
    await expect(createInvoiceRepo(prisma as never, ORG_A).update("inv-a1", { customerId: "customer-b" })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
  it("scopes every list/count call to the tenant", async () => {
    const { prisma } = makePrisma();
    const repo = createInvoiceRepo(prisma as never, ORG_A);
    await repo.list({ status: "SENT", page: 2, pageSize: 10 });
    await repo.count({ search: "Acme" });
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_A, status: "SENT" }) }));
    expect(prisma.invoice.count).toHaveBeenCalledWith({ where: expect.objectContaining({ organizationId: ORG_A }) });
  });
});

describe("Invoice number allocation + money recompute", () => {
  it("allocates the next tenant-local invoice number under the per-org advisory lock", async () => {
    const { prisma, locks } = makePrisma();
    const created = await createInvoiceRepo(prisma as never, ORG_A).create(createData);
    expect(locks).toHaveBeenCalledTimes(1);
    expect(created.invoiceNumber).toBe(8); // org-b's #99 is not visible to org-a allocation
    expect(created.status).toBe("DRAFT");
    expect(prisma.invoice.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: ORG_A, invoiceNumber: 8, totalCents: 2700, balanceCents: 2700 }),
    }));
  });
  it("opens a transaction before allocating a number when composed from a Prisma client", async () => {
    const { prisma } = makePrisma();
    const tx = {
      $executeRaw: prisma.$executeRaw,
      customer: prisma.customer,
      job: prisma.job,
      invoice: prisma.invoice,
    };
    prisma.$transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
    await createInvoiceRepo(prisma as never, ORG_A).create(createData);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it("recomputes totals server-side on update and keeps the row's paidCents", async () => {
    const { prisma } = makePrisma();
    const updated = await createInvoiceRepo(prisma as never, ORG_A).update("inv-a2", { subtotalCents: 6000, taxCents: 480 });
    expect(updated.totalCents).toBe(6480); // 6000 + 480 — never a client-supplied total
    expect(updated.balanceCents).toBe(4480); // 6480 − paidCents 2000
  });
  it("never writes protected fields (status/paid state/number) through update", async () => {
    const { prisma } = makePrisma();
    // Runtime-level injection attempt: protected fields must be dropped.
    const injected = { status: "PAID", paidCents: 99999, invoiceNumber: 1, paidAt: NOW };
    await createInvoiceRepo(prisma as never, ORG_A).update("inv-a1", {
      subtotalCents: 100,
      ...injected,
    } as never);
    const data = prisma.invoice.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("paidCents");
    expect(data).not.toHaveProperty("paidAt");
    expect(data).not.toHaveProperty("invoiceNumber");
  });
  it("recomputeInvoiceTotals is integer-exact", () => {
    expect(recomputeInvoiceTotals(1099, 88, 0)).toEqual({ totalCents: 1187, balanceCents: 1187 });
    expect(recomputeInvoiceTotals(100, 10, 110)).toEqual({ totalCents: 110, balanceCents: 0 });
  });
  it("invoiceListWhere keeps the tenant predicate and numeric search", () => {
    const where = invoiceListWhere(ORG_A, { search: "7", customerId: "customer-a" });
    expect(where.organizationId).toBe(ORG_A);
    expect(JSON.stringify(where.OR)).toContain("7");
  });
});

describe("Invoice setStatus — transition map + optimistic guard", () => {
  it("stamps paidAt when SENT reaches PAID at zero balance", async () => {
    const { prisma, invoices } = makePrisma();
    const settled = invoices.find((invoice) => invoice.id === "inv-a1")!;
    settled.balanceCents = 0;
    settled.paidCents = settled.totalCents;
    const updated = await createInvoiceRepo(prisma as never, ORG_A).setStatus("inv-a1", "PAID", { now: NOW });
    expect(updated.status).toBe("PAID");
    expect(updated.paidAt).toEqual(NOW);
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: "inv-a1", organizationId: ORG_A, status: "SENT" },
      data: { status: "PAID", paidAt: NOW },
    });
  });
  it("rejects PAID while a balance is outstanding (ConflictError, no write)", async () => {
    const { prisma } = makePrisma();
    await expect(createInvoiceRepo(prisma as never, ORG_A).setStatus("inv-a1", "PAID")).rejects.toThrow(/balance reaches zero/);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
  it("rejects out-of-map moves and the derived OVERDUE target", async () => {
    const { prisma } = makePrisma();
    const repo = createInvoiceRepo(prisma as never, ORG_A);
    await expect(repo.setStatus("inv-a1", "OVERDUE")).rejects.toBeInstanceOf(ConflictError);
    await expect(repo.setStatus("inv-a2", "SENT")).rejects.toBeInstanceOf(ConflictError);
    await expect(repo.setStatus("inv-a2", "PAID")).rejects.toThrow(/balance reaches zero/);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
  it("fails closed on a concurrent status change instead of overwriting", async () => {
    const { prisma, invoices } = makePrisma();
    const settled = invoices.find((invoice) => invoice.id === "inv-a1")!;
    settled.balanceCents = 0;
    settled.paidCents = settled.totalCents;
    // The row moved between read and write — the observed-status guard misses.
    const originalUpdateMany = prisma.invoice.updateMany;
    prisma.invoice.updateMany = vi.fn(async (args: any) => (args.data.status === "PAID" ? { count: 0 } : originalUpdateMany(args)));
    await expect(createInvoiceRepo(prisma as never, ORG_A).setStatus("inv-a1", "PAID", { now: NOW })).rejects.toThrow(/changed before this transition/);
  });
  it("a same-status request is a no-op (no write)", async () => {
    const { prisma } = makePrisma();
    const updated = await createInvoiceRepo(prisma as never, ORG_A).setStatus("inv-a1", "SENT");
    expect(updated.status).toBe("SENT");
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
  it("transitions with the CUID-typed id and tenant only — never a raw org-wide update", async () => {
    const { prisma } = makePrisma();
    await createInvoiceRepo(prisma as never, ORG_A).setStatus("inv-a2", "VOID");
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: "inv-a2", organizationId: ORG_A, status: "PARTIALLY_PAID" },
      data: { status: "VOID" },
    });
  });
});
