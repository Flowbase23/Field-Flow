import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/lib/errors";
import { createJobRepo } from "@/server/repositories/job.repo";

const ORG_A = "org-a";
const ORG_B = "org-b";

function dispatchPrisma() {
  const technicians = [
    { id: "tech-a", organizationId: ORG_A, isActive: true },
    { id: "tech-b", organizationId: ORG_A, isActive: true },
    { id: "tech-off-tenant", organizationId: ORG_B, isActive: true },
  ];
  const assignments = [{ jobId: "job-a", technicianId: "tech-a", organizationId: ORG_A, isPrimary: true }];
  const jobTechnician = {
    updateMany: vi.fn(async ({ where, data }) => {
      assignments.filter((row) => row.jobId === where.jobId && row.organizationId === where.organizationId && (!where.isPrimary || row.isPrimary)).forEach((row) => Object.assign(row, data));
      return { count: 1 };
    }),
    upsert: vi.fn(async ({ create, update }) => {
      const existing = assignments.find((row) => row.jobId === create.jobId && row.technicianId === create.technicianId);
      if (existing) Object.assign(existing, update); else assignments.push(create);
      return existing ?? create;
    }),
    findFirst: vi.fn(async ({ where }) => assignments.find((row) => row.jobId === where.jobId && row.technicianId === where.technicianId && row.organizationId === where.organizationId) ?? null),
    update: vi.fn(async ({ where, data }) => {
      const row = assignments.find((item) => item.jobId === where.jobId_technicianId.jobId && item.technicianId === where.jobId_technicianId.technicianId);
      if (!row) throw new Error("missing"); Object.assign(row, data); return row;
    }),
    deleteMany: vi.fn(async ({ where }) => {
      const index = assignments.findIndex((row) => row.jobId === where.jobId && row.technicianId === where.technicianId && row.organizationId === where.organizationId);
      if (index >= 0) assignments.splice(index, 1); return { count: index >= 0 ? 1 : 0 };
    }),
  };
  const prisma = {
    job: { findFirst: vi.fn(async ({ where }) => where.id === "job-a" && where.organizationId === ORG_A ? { id: "job-a" } : null) },
    technician: { findFirst: vi.fn(async ({ where }) => technicians.find((row) => row.id === where.id && row.organizationId === where.organizationId) ?? null) },
    jobTechnician,
  };
  return { prisma, assignments, jobTechnician };
}

describe("job dispatch assignment invariants", () => {
  it("promotes one technician transactionally by demoting the previous primary", async () => {
    const { prisma, assignments, jobTechnician } = dispatchPrisma();
    await createJobRepo(prisma as never, ORG_A).assignTechnician("job-a", "tech-b", true);
    expect(assignments.filter((assignment) => assignment.isPrimary)).toEqual([expect.objectContaining({ technicianId: "tech-b" })]);
    expect(jobTechnician.updateMany).toHaveBeenCalledWith({ where: { jobId: "job-a", organizationId: ORG_A, isPrimary: true }, data: { isPrimary: false } });
  });

  it("rejects an off-tenant technician before writing an assignment", async () => {
    const { prisma, jobTechnician } = dispatchPrisma();
    await expect(createJobRepo(prisma as never, ORG_A).assignTechnician("job-a", "tech-off-tenant", false)).rejects.toBeInstanceOf(NotFoundError);
    expect(jobTechnician.upsert).not.toHaveBeenCalled();
  });

  it("does not allow an unassigned technician to become primary", async () => {
    const { prisma } = dispatchPrisma();
    await expect(createJobRepo(prisma as never, ORG_A).setPrimaryTechnician("job-a", "tech-b")).rejects.toThrow("must be assigned");
  });

  it("removing a primary deletes the join, leaving zero primary assignments", async () => {
    const { prisma, assignments } = dispatchPrisma();
    await createJobRepo(prisma as never, ORG_A).unassignTechnician("job-a", "tech-a");
    expect(assignments).toEqual([]);
  });
});
