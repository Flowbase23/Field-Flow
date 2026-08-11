/** Repository guard tests use a small Prisma-shaped fake at the repo seam. */
import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { createJobRepo } from "@/server/repositories/job.repo";

const ORG_A = "org-a";
const ORG_B = "org-b";
const NOW = new Date("2026-08-10T15:00:00.000Z");

function makePrisma() {
  const customers = [
    { id: "customer-a", organizationId: ORG_A },
    { id: "customer-other", organizationId: ORG_A },
    { id: "customer-b", organizationId: ORG_B },
  ];
  const locations = [
    { id: "location-a", organizationId: ORG_A, customerId: "customer-a" },
    { id: "location-other-customer", organizationId: ORG_A, customerId: "customer-other" },
    { id: "location-b", organizationId: ORG_B, customerId: "customer-b" },
  ];
  const leads = [{ id: "lead-a", organizationId: ORG_A }, { id: "lead-b", organizationId: ORG_B }];
  const jobs: Array<Record<string, unknown>> = [
    { id: "old-a", organizationId: ORG_A, jobNumber: 7, customerId: "customer-a", locationId: "location-a", leadId: null, status: "DRAFT" },
    { id: "old-b", organizationId: ORG_B, jobNumber: 99, customerId: "customer-b", locationId: "location-b", leadId: null, status: "DRAFT" },
  ];
  const locks = vi.fn().mockResolvedValue([]);

  const prisma = {
    $queryRaw: locks,
    customer: { findFirst: vi.fn(async ({ where }: { where: { id: string; organizationId: string } }) => customers.find((row) => row.id === where.id && row.organizationId === where.organizationId) ?? null) },
    location: { findFirst: vi.fn(async ({ where }: { where: { id: string; organizationId: string } }) => locations.find((row) => row.id === where.id && row.organizationId === where.organizationId) ?? null) },
    lead: { findFirst: vi.fn(async ({ where }: { where: { id: string; organizationId: string } }) => leads.find((row) => row.id === where.id && row.organizationId === where.organizationId) ?? null) },
    job: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: { id?: string; organizationId: string }; orderBy?: unknown }) => {
        const matches = jobs.filter((row) => row.organizationId === where.organizationId && (!where.id || row.id === where.id));
        if (orderBy) return [...matches].sort((a, b) => Number(b.jobNumber) - Number(a.jobNumber))[0] ?? null;
        return matches[0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `job-${jobs.length}`, ...data };
        jobs.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: { where: { id_organizationId: { id: string; organizationId: string } }; data: Record<string, unknown> }) => {
        const row = jobs.find((job) => job.id === where.id_organizationId.id && job.organizationId === where.id_organizationId.organizationId);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; organizationId: string; status: string }; data: Record<string, unknown> }) => {
        const row = jobs.find((job) => job.id === where.id && job.organizationId === where.organizationId && job.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
  return { prisma, locks, jobs };
}

const createData = { customerId: "customer-a", locationId: "location-a", type: "SERVICE_CALL" as const, title: "No cooling" };

describe("Job repository tenant/relation guards", () => {
  it("rejects a customer from another tenant before creating", async () => {
    const { prisma } = makePrisma();
    await expect(createJobRepo(prisma as never, ORG_A).create({ ...createData, customerId: "customer-b" })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it("rejects an in-tenant location that belongs to a different customer", async () => {
    const { prisma } = makePrisma();
    await expect(createJobRepo(prisma as never, ORG_A).create({ ...createData, locationId: "location-other-customer" })).rejects.toThrow("does not belong to the selected customer");
    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it("rejects optional leads from another tenant", async () => {
    const { prisma } = makePrisma();
    await expect(createJobRepo(prisma as never, ORG_A).create({ ...createData, leadId: "lead-b" })).rejects.toBeInstanceOf(NotFoundError);
    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it("re-checks the final customer/location tuple on update", async () => {
    const { prisma } = makePrisma();
    await expect(createJobRepo(prisma as never, ORG_A).update("old-a", { customerId: "customer-other" })).rejects.toThrow("does not belong to the selected customer");
    expect(prisma.job.update).not.toHaveBeenCalled();
  });

  it("allocates next tenant-local job number under an advisory transaction lock", async () => {
    const { prisma, locks } = makePrisma();
    const created = await createJobRepo(prisma as never, ORG_A).create({ ...createData, leadId: "lead-a" });
    expect(locks).toHaveBeenCalledTimes(1);
    expect(created.jobNumber).toBe(8); // org-b's #99 is not visible to org-a allocation
    expect(prisma.job.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ organizationId: ORG_A, jobNumber: 8, leadId: "lead-a", status: "DRAFT" }) }));
  });

  it("opens a transaction before allocating a number when composed from a Prisma client", async () => {
    const { prisma } = makePrisma();
    const tx = { $queryRaw: prisma.$queryRaw, customer: prisma.customer, location: prisma.location, lead: prisma.lead, job: prisma.job };
    const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
    Object.assign(prisma, { $transaction: transaction });

    await createJobRepo(prisma as never, ORG_A).create(createData);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("uses the expected prior status and only writes lifecycle timestamps supplied by the transition", async () => {
    const { prisma } = makePrisma();
    const updated = await createJobRepo(prisma as never, ORG_A).updateStatus("old-a", "DRAFT", {
      status: "CANCELLED",
      cancelledAt: NOW,
    });

    expect(updated.status).toBe("CANCELLED");
    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: { id: "old-a", organizationId: ORG_A, status: "DRAFT" },
      data: { status: "CANCELLED", cancelledAt: NOW },
    });
  });

  it("rejects stale lifecycle writes instead of overwriting a concurrent transition", async () => {
    const { prisma } = makePrisma();
    await expect(
      createJobRepo(prisma as never, ORG_A).updateStatus("old-a", "SCHEDULED", { status: "EN_ROUTE" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
