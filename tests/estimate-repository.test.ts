/** Estimate repository guard tests use a small Prisma-shaped fake at the repo seam. */
import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { createEstimateRepo, estimateListWhere, recomputeEstimateTotals } from "@/server/repositories/estimate.repo";

const ORG_A = "org-a";
const ORG_B = "org-b";
const NOW = new Date("2026-10-01T15:00:00.000Z");

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
  const estimates: Row[] = [
    { id: "est-a1", organizationId: ORG_A, estimateNumber: 2, customerId: "customer-a", jobId: null, status: "SENT", title: null, validUntil: null, sentAt: NOW, acceptedAt: null, declinedAt: null, subtotalCents: 12000, taxCents: 960, totalCents: 12960 },
    { id: "est-a2", organizationId: ORG_A, estimateNumber: 5, customerId: "customer-a", jobId: "job-a", status: "DRAFT", title: "Replacement", validUntil: null, sentAt: null, acceptedAt: null, declinedAt: null, subtotalCents: 8000, taxCents: 0, totalCents: 8000 },
    { id: "est-b1", organizationId: ORG_B, estimateNumber: 42, customerId: "customer-b", jobId: "job-b", status: "DRAFT", title: null, validUntil: null, sentAt: null, acceptedAt: null, declinedAt: null, subtotalCents: 1, taxCents: 0, totalCents: 1 },
  ];
  const locks = vi.fn().mockResolvedValue([]);
  function match(where: any): Row[] {
    return estimates.filter((row) => {
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
    estimate: {
      findFirst: vi.fn(async ({ where, orderBy, select }: any) => {
        const matches = match(where);
        const row = orderBy?.estimateNumber === "desc"
          ? [...matches].sort((a, b) => Number(b.estimateNumber) - Number(a.estimateNumber))[0]
          : matches[0];
        if (!row) return null;
        return select?.estimateNumber ? { estimateNumber: row.estimateNumber } : { ...row };
      }),
      findMany: vi.fn(async ({ where, orderBy, take = 25, skip = 0 }: any) => {
        let rows = match(where);
        if (orderBy?.[0]?.estimateNumber === "desc") rows = [...rows].sort((a, b) => Number(b.estimateNumber) - Number(a.estimateNumber));
        return rows.slice(skip, skip + take).map((row) => ({
          ...row,
          customer: { id: "customer-x", firstName: "A", lastName: "B", companyName: null },
        }));
      }),
      count: vi.fn(async ({ where }: any) => match(where).length),
      create: vi.fn(async ({ data }: any) => {
        const created = { id: `est-${estimates.length + 1}`, sentAt: null, acceptedAt: null, declinedAt: null, ...data };
        estimates.push(created);
        return created;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = estimates.find((estimate) => estimate.id === where.id && estimate.organizationId === where.organizationId && (where.status === undefined || estimate.status === where.status));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  return { prisma, locks, estimates };
}
const createData = { customerId: "customer-a", subtotalCents: 2500, taxCents: 200 };

describe("Estimate repository tenant guards", () => {
  it("rejects a customer from another tenant before creating", async () => {
    const { prisma } = makePrisma();
    await expect(createEstimateRepo(prisma as never, ORG_A).create({ ...createData, customerId: "customer-b" })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.estimate.create).not.toHaveBeenCalled();
  });
  it("rejects an optional job link from another tenant", async () => {
    const { prisma } = makePrisma();
    await expect(createEstimateRepo(prisma as never, ORG_A).create({ ...createData, jobId: "job-b" })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.estimate.create).not.toHaveBeenCalled();
  });
  it("rejects cross-tenant ids on reads and updates", async () => {
    const { prisma } = makePrisma();
    expect(await createEstimateRepo(prisma as never, ORG_A).getById("est-b1")).toBeNull();
    await expect(createEstimateRepo(prisma as never, ORG_A).getDetail("est-b1")).resolves.toBeNull();
    await expect(createEstimateRepo(prisma as never, ORG_A).update("est-b1", { validUntil: NOW })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createEstimateRepo(prisma as never, ORG_A).setStatus("est-b1", "VOID")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("re-checks the new customer link on update before writing", async () => {
    const { prisma } = makePrisma();
    await expect(createEstimateRepo(prisma as never, ORG_A).update("est-a1", { customerId: "customer-b" })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
  });
  it("scopes every list/count call to the tenant", async () => {
    const { prisma } = makePrisma();
    const repo = createEstimateRepo(prisma as never, ORG_A);
    await repo.list({ status: "SENT", page: 2, pageSize: 10 });
    await repo.count({ search: "Acme" });
    expect(prisma.estimate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_A, status: "SENT" }) }));
    expect(prisma.estimate.count).toHaveBeenCalledWith({ where: expect.objectContaining({ organizationId: ORG_A }) });
  });
});

describe("Estimate number allocation + money recompute", () => {
  it("allocates the next tenant-local estimate number under the per-org advisory lock", async () => {
    const { prisma, locks } = makePrisma();
    const created = await createEstimateRepo(prisma as never, ORG_A).create(createData);
    expect(locks).toHaveBeenCalledTimes(1);
    expect(created.estimateNumber).toBe(6); // org-b's #42 is not visible to org-a allocation
    expect(created.status).toBe("DRAFT");
    expect(prisma.estimate.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ organizationId: ORG_A, estimateNumber: 6, totalCents: 2700 }),
    }));
  });
  it("opens a transaction before allocating a number when composed from a Prisma client", async () => {
    const { prisma } = makePrisma();
    const tx = {
      $executeRaw: prisma.$executeRaw,
      customer: prisma.customer,
      job: prisma.job,
      estimate: prisma.estimate,
    };
    prisma.$transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
    await createEstimateRepo(prisma as never, ORG_A).create(createData);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it("recomputes the total server-side on update (never a client-supplied total)", async () => {
    const { prisma } = makePrisma();
    const updated = await createEstimateRepo(prisma as never, ORG_A).update("est-a2", { subtotalCents: 6000, taxCents: 480 });
    expect(updated.totalCents).toBe(6480); // 6000 + 480
  });
  it("never writes protected fields (status/stamps/number) through update", async () => {
    const { prisma } = makePrisma();
    // Runtime-level injection attempt: protected fields must be dropped.
    const injected = { status: "ACCEPTED", estimateNumber: 1, sentAt: NOW, acceptedAt: NOW, declinedAt: NOW };
    await createEstimateRepo(prisma as never, ORG_A).update("est-a2", {
      subtotalCents: 100,
      ...injected,
    } as never);
    const data = prisma.estimate.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("estimateNumber");
    expect(data).not.toHaveProperty("sentAt");
    expect(data).not.toHaveProperty("acceptedAt");
    expect(data).not.toHaveProperty("declinedAt");
  });
  it("recomputeEstimateTotals is integer-exact", () => {
    expect(recomputeEstimateTotals(1099, 88)).toEqual({ totalCents: 1187 });
    expect(recomputeEstimateTotals(0, 0)).toEqual({ totalCents: 0 });
  });
  it("estimateListWhere keeps the tenant predicate, numeric search, and the derived EXPIRED filter", () => {
    const where = estimateListWhere(ORG_A, { search: "5", customerId: "customer-a" });
    expect(where.organizationId).toBe(ORG_A);
    expect(JSON.stringify(where.OR)).toContain("5");
    const expired = estimateListWhere(ORG_A, { status: "EXPIRED" }, NOW);
    expect(expired.status).toBe("SENT");
    expect((expired.validUntil as any).lt).toEqual(NOW);
  });
});

describe("Estimate setStatus — transition map + optimistic guard", () => {
  it("stamps sentAt/acceptedAt through valid transitions", async () => {
    const { prisma } = makePrisma();
    const updated = await createEstimateRepo(prisma as never, ORG_A).setStatus("est-a2", "SENT", { now: NOW });
    expect(updated.status).toBe("SENT");
    expect(updated.sentAt).toEqual(NOW);
    expect(prisma.estimate.updateMany).toHaveBeenCalledWith({
      where: { id: "est-a2", organizationId: ORG_A, status: "DRAFT" },
      data: { status: "SENT", sentAt: NOW },
    });
    const accepted = await createEstimateRepo(prisma as never, ORG_A).setStatus("est-a1", "ACCEPTED", { now: NOW });
    expect(accepted.acceptedAt).toEqual(NOW);
  });
  it("rejects out-of-map moves (DRAFT → ACCEPTED) with no write", async () => {
    const { prisma } = makePrisma();
    await expect(createEstimateRepo(prisma as never, ORG_A).setStatus("est-a2", "ACCEPTED")).rejects.toBeInstanceOf(ConflictError);
    await expect(createEstimateRepo(prisma as never, ORG_A).setStatus("est-a1", "DRAFT")).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
  });
  it("fails closed on a concurrent status change instead of overwriting", async () => {
    const { prisma } = makePrisma();
    // The row moved between read and write — the observed-status guard misses.
    const originalUpdateMany = prisma.estimate.updateMany;
    prisma.estimate.updateMany = vi.fn(async (args: any) => (args.data.status === "SENT" ? { count: 0 } : originalUpdateMany(args)));
    await expect(createEstimateRepo(prisma as never, ORG_A).setStatus("est-a2", "SENT", { now: NOW })).rejects.toThrow(/changed before this transition/);
  });
  it("a same-status request is a no-op (no write)", async () => {
    const { prisma } = makePrisma();
    const updated = await createEstimateRepo(prisma as never, ORG_A).setStatus("est-a1", "SENT");
    expect(updated.status).toBe("SENT");
    expect(prisma.estimate.updateMany).not.toHaveBeenCalled();
  });
  it("transitions with the CUID-typed id and tenant only — never a raw org-wide update", async () => {
    const { prisma } = makePrisma();
    await createEstimateRepo(prisma as never, ORG_A).setStatus("est-a1", "DECLINED", { now: NOW });
    expect(prisma.estimate.updateMany).toHaveBeenCalledWith({
      where: { id: "est-a1", organizationId: ORG_A, status: "SENT" },
      data: { status: "DECLINED", declinedAt: NOW },
    });
  });
});
