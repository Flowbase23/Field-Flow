import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/lib/errors";
import { createAppointmentRepo } from "@/server/repositories/appointment.repo";

const ORG_A = "org-a";
const ORG_B = "org-b";
function linksPrisma() {
  const jobs = [{ id: "job-a", organizationId: ORG_A, customerId: "customer-a", locationId: "location-a" }, { id: "job-b", organizationId: ORG_B, customerId: "customer-b", locationId: "location-b" }];
  const locations = [{ id: "location-a", organizationId: ORG_A, customerId: "customer-a" }, { id: "location-other", organizationId: ORG_A, customerId: "customer-other" }, { id: "location-b", organizationId: ORG_B, customerId: "customer-b" }];
  const appointment = { create: vi.fn(async ({ data }) => ({ id: "appointment-a", ...data })), findMany: vi.fn(), findFirst: vi.fn() };
  return {
    appointment,
    prisma: {
      job: { findFirst: vi.fn(async ({ where }) => jobs.find((job) => job.id === where.id && job.organizationId === where.organizationId) ?? null) },
      location: { findFirst: vi.fn(async ({ where }) => locations.find((location) => location.id === where.id && location.organizationId === where.organizationId) ?? null) },
      appointment,
    },
  };
}
const data = { title: "Replace unit", type: "JOB" as const, startsAt: new Date("2026-08-11T13:00:00Z"), endsAt: new Date("2026-08-11T14:00:00Z"), timezone: "America/New_York", jobId: "job-a", locationId: "location-a" };

describe("job appointment relation guard", () => {
  it("accepts a job appointment only at that job's in-tenant service location", async () => {
    const { prisma, appointment } = linksPrisma();
    await createAppointmentRepo(prisma as never, ORG_A).create(data, []);
    expect(appointment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ organizationId: ORG_A, jobId: "job-a", locationId: "location-a" }) }));
  });
  it("rejects a mismatched in-tenant location before the appointment write", async () => {
    const { prisma, appointment } = linksPrisma();
    await expect(createAppointmentRepo(prisma as never, ORG_A).create({ ...data, locationId: "location-other" }, [])).rejects.toThrow("service location");
    expect(appointment.create).not.toHaveBeenCalled();
  });
  it("rejects a cross-tenant job before the appointment write", async () => {
    const { prisma, appointment } = linksPrisma();
    await expect(createAppointmentRepo(prisma as never, ORG_A).create({ ...data, jobId: "job-b", locationId: "location-b" }, [])).rejects.toBeInstanceOf(NotFoundError);
    expect(appointment.create).not.toHaveBeenCalled();
  });
});
