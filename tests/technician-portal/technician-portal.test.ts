/**
 * Technician portal (P2-S5) scoping + validation tests:
 * - time-entry repo validation (positive whole minutes ≤24h, span consistency);
 * - tenant isolation on every time-entry read/write (foreign job/technician
 *   ids, cross-tenant reads);
 * - technician scoping on job list/detail (own assignments only) and
 *   appointment range filtering (listInRange technicianIds);
 * - the pure portal helpers (span resolution, day grouping) and the nav
 *   visibility rule (technicians see "My …" views, staff see the org-wide ones).
 *
 * Repos are exercised against small Prisma-shaped fakes at the repo seam (same
 * discipline as tests/payment-repository.test.ts). Pure vitest — also runs
 * under `bun test` (the project gate).
 */
import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { createTimeEntryRepo } from "@/server/repositories/time-entry.repo";
import { createJobRepo } from "@/server/repositories/job.repo";
import { createAppointmentRepo } from "@/server/repositories/appointment.repo";
import { groupAppointmentsByDay, resolveLoggedSpan, formatMinutes } from "@/features/technician-portal/technician-portal-ui";
import { NAV_ITEMS, visibleNavItems } from "@/components/layout/nav-items";

const ORG_A = "org-a";
const ORG_B = "org-b";
const TECH_SELF = "tech-self";
const TECH_OTHER = "tech-other";
const JOB_A = "job-a1";
const JOB_B = "job-b1";
const NOW = new Date("2026-10-03T12:00:00.000Z");

function makePrisma(tables: {
  technicians?: Array<Record<string, any>>;
  jobs?: Array<Record<string, any>>;
  assignments?: Array<Record<string, any>>;
  entries?: Array<Record<string, any>>;
  appointments?: Array<Record<string, any>>;
}) {
  const technicians = tables.technicians ?? [];
  const jobs = tables.jobs ?? [];
  const assignments = tables.assignments ?? [];
  const entries = tables.entries ?? [];
  const appointments = tables.appointments ?? [];
  let entrySeq = 0;
  function filter(rows: Array<Record<string, any>>, where: any) {
    return rows.filter((row) => {
      if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
      if (where.id !== undefined && row.id !== where.id) return false;
      if (where.technicianId !== undefined && row.technicianId !== where.technicianId) return false;
      if (where.jobId !== undefined && row.jobId !== where.jobId) return false;
      if (where.technicians?.some?.technicianId !== undefined) {
        const wanted = where.technicians.some.technicianId;
        const ids = Array.isArray(wanted?.in) ? wanted.in : [wanted];
        if (!row.techIds.some((id: string) => ids.includes(id))) return false;
      }
      if (where.startedAt) {
        if (where.startedAt.gte !== undefined && row.startedAt < where.startedAt.gte) return false;
        if (where.startedAt.lt !== undefined && row.startedAt >= where.startedAt.lt) return false;
      }
      if (where.startsAt?.lt !== undefined && !(row.startsAt < where.startsAt.lt)) return false;
      if (where.endsAt?.gt !== undefined && !(row.endsAt > where.endsAt.gt)) return false;
      return true;
    });
  }
  const first = (rows: Array<Record<string, any>>, where: any) => filter(rows, where)[0] ?? null;
  return {
    prisma: {
      technician: {
        findFirst: async ({ where }: any) => first(technicians, where) ?? null,
      },
      job: {
        findFirst: async ({ where }: any) => first(jobs, where) ?? null,
        findMany: async ({ where }: any) => filter(jobs, where),
      },
      jobTechnician: {
        findFirst: async ({ where }: any) => first(assignments, where) ?? null,
      },
      timeEntry: {
        findMany: async ({ where }: any) => filter(entries, where),
        findFirst: async ({ where }: any) => first(entries, where) ?? null,
        create: async ({ data }: any) => {
          const created = { id: `entry-${(entrySeq += 1)}`, createdAt: NOW, updatedAt: NOW, endedAt: null, ...data };
          entries.push(created);
          return created;
        },
      },
      appointment: {
        findMany: async ({ where }: any) => filter(appointments, where),
      },
    } as never,
    entries,
  };
}

const entrySeed = { id: "entry-1", organizationId: ORG_A, technicianId: TECH_SELF, jobId: JOB_A, startedAt: NOW, endedAt: null, minutes: 60, billable: false, createdAt: NOW, updatedAt: NOW };

describe("TimeEntry validation (server-authoritative)", () => {
  it.each([
    ["zero minutes", 0],
    ["negative minutes", -60],
    ["fractional minutes", 45.5],
    ["over 24h", 24 * 60 + 1],
  ])("rejects %s before any write", async (_label, minutes) => {
    const { prisma, entries } = makePrisma({});
    await expect(createTimeEntryRepo(prisma, ORG_A).create({ technicianId: TECH_SELF, startedAt: NOW, minutes })).rejects.toBeInstanceOf(ValidationError);
    expect(entries).toHaveLength(0);
  });
  it("rejects an end time before the start", async () => {
    const { prisma, entries } = makePrisma({ technicians: [{ id: TECH_SELF, organizationId: ORG_A }] });
    await expect(
      createTimeEntryRepo(prisma, ORG_A).create({ technicianId: TECH_SELF, startedAt: NOW, endedAt: new Date(NOW.getTime() - 60_000), minutes: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(entries).toHaveLength(0);
  });
  it("rejects minutes that do not match the recorded span", async () => {
    const { prisma } = makePrisma({ technicians: [{ id: TECH_SELF, organizationId: ORG_A }] });
    await expect(
      createTimeEntryRepo(prisma, ORG_A).create({ technicianId: TECH_SELF, startedAt: NOW, endedAt: new Date(NOW.getTime() + 60_000), minutes: 90 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
  it("creates a valid entry (billable defaults false)", async () => {
    const { prisma, entries } = makePrisma({
      technicians: [{ id: TECH_SELF, organizationId: ORG_A }],
      jobs: [{ id: JOB_A, organizationId: ORG_A }],
      assignments: [{ jobId: JOB_A, technicianId: TECH_SELF, organizationId: ORG_A }],
    });
    const created = await createTimeEntryRepo(prisma, ORG_A).create({ technicianId: TECH_SELF, jobId: JOB_A, startedAt: NOW, minutes: 90, billable: true });
    expect(created.minutes).toBe(90);
    expect(entries).toHaveLength(1);
    const defaultBillable = await createTimeEntryRepo(prisma, ORG_A).create({ technicianId: TECH_SELF, minutes: 30, startedAt: NOW });
    expect(defaultBillable.billable).toBe(false);
    expect(entries).toHaveLength(2);
  });
});

describe("TimeEntry tenant isolation + assignment", () => {
  const base = {
    technicians: [{ id: TECH_SELF, organizationId: ORG_A }],
    jobs: [{ id: JOB_A, organizationId: ORG_A }, { id: JOB_B, organizationId: ORG_B }],
    assignments: [{ jobId: JOB_A, technicianId: TECH_SELF, organizationId: ORG_A }],
  };
  it("rejects a foreign job id", async () => {
    const { prisma, entries } = makePrisma(base);
    await expect(createTimeEntryRepo(prisma, ORG_A).create({ technicianId: TECH_SELF, jobId: JOB_B, minutes: 30, startedAt: NOW })).rejects.toBeInstanceOf(NotFoundError);
    expect(entries).toHaveLength(0);
  });
  it("rejects logging against a job the technician is NOT assigned to", async () => {
    const { prisma, entries } = makePrisma({ ...base, jobs: [{ id: JOB_A, organizationId: ORG_A }], assignments: [] });
    await expect(createTimeEntryRepo(prisma, ORG_A).create({ technicianId: TECH_SELF, jobId: JOB_A, minutes: 30, startedAt: NOW })).rejects.toThrow(/assigned/i);
    expect(entries).toHaveLength(0);
  });
  it("rejects a foreign technician id", async () => {
    const { prisma, entries } = makePrisma(base);
    await expect(createTimeEntryRepo(prisma, ORG_A).create({ technicianId: TECH_OTHER, minutes: 30, startedAt: NOW })).rejects.toBeInstanceOf(NotFoundError);
    expect(entries).toHaveLength(0);
  });
  it("hides cross-tenant rows on reads and scopes lists", async () => {
    const { prisma } = makePrisma({
      ...base,
      entries: [entrySeed, { ...entrySeed, id: "entry-2", organizationId: ORG_B, technicianId: TECH_OTHER }],
    });
    const repo = createTimeEntryRepo(prisma, ORG_A);
    expect(await repo.getById("entry-2")).toBeNull();
    expect(await repo.listForTechnician(TECH_SELF)).toHaveLength(1);
    expect(await repo.listForTechnician(TECH_OTHER)).toHaveLength(0);
    expect(await repo.listForJob(JOB_A, { technicianId: TECH_SELF })).toHaveLength(1);
    expect(await repo.listForJob(JOB_B)).toHaveLength(0);
  });
});

describe("Job + appointment technician scoping", () => {
  const jobRow = { id: JOB_A, organizationId: ORG_A, techIds: [TECH_SELF], customer: { id: "c1", companyName: null, firstName: "Jan", lastName: "Doe" }, location: null };
  it("lists ONLY the technician's assigned jobs", async () => {
    const { prisma } = makePrisma({
      jobs: [jobRow, { ...jobRow, id: JOB_B, techIds: [TECH_OTHER] }, { ...jobRow, id: "job-foreign", organizationId: ORG_B, techIds: [TECH_SELF] }],
    });
    const jobs = await createJobRepo(prisma, ORG_A).listForTechnician(TECH_SELF);
    expect(jobs.map((j) => j.id)).toEqual([JOB_A]);
  });
  it("returns detail only when assigned; null for unassigned or foreign jobs", async () => {
    const { prisma } = makePrisma({ jobs: [jobRow] });
    const repo = createJobRepo(prisma, ORG_A);
    expect((await repo.getDetailForTechnician(JOB_A, TECH_SELF))!.id).toBe(JOB_A);
    expect(await repo.getDetailForTechnician(JOB_A, TECH_OTHER)).toBeNull();
    expect(await repo.getDetailForTechnician(JOB_B, TECH_SELF)).toBeNull();
  });
  it("filters the appointment range to the requested technicians only", async () => {
    const appointment = (id: string, techIds: string[], organizationId = ORG_A) => ({
      id, organizationId, techIds,
      startsAt: new Date("2026-10-03T09:00:00.000Z"), endsAt: new Date("2026-10-03T10:00:00.000Z"),
      job: { id: JOB_A, title: "Fix" }, location: { id: "loc-1", label: "Main St" },
      technicians: techIds.map((technicianId) => ({ technicianId, technician: { id: technicianId, user: { id: "u", firstName: "T", lastName: "X", email: "t@x.io" } } })),
    });
    const { prisma } = makePrisma({ appointments: [appointment("appt-1", [TECH_SELF]), appointment("appt-2", [TECH_OTHER]), appointment("appt-3", [TECH_SELF], ORG_B)] });
    const rows = await createAppointmentRepo(prisma, ORG_A).listInRange({
      start: new Date("2026-10-03T00:00:00.000Z"), end: new Date("2026-10-04T00:00:00.000Z"), technicianIds: [TECH_SELF],
    });
    expect(rows.map((r) => r.id)).toEqual(["appt-1"]);
    expect(rows[0]!.technicians[0]!.technician.user.email).toBe("t@x.io");
  });
});

describe("Pure helpers", () => {
  it("derives the span server-side and ignores client hours when a span is given", () => {
    const span = resolveLoggedSpan({ workDate: "2026-10-03", startTime: "09:00", endTime: "10:30", hours: 99 }, "UTC");
    expect(span.minutes).toBe(90);
    expect(span.endedAt!.toISOString()).toBe("2026-10-03T10:30:00.000Z");
    const manual = resolveLoggedSpan({ workDate: "2026-10-03", hours: 1.5 }, "UTC");
    expect(manual.minutes).toBe(90);
    expect(manual.startedAt.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(manual.endedAt).toBeNull();
  });
  it("rejects a span that ends before it starts", () => {
    expect(() => resolveLoggedSpan({ workDate: "2026-10-03", startTime: "10:00", endTime: "09:00" }, "UTC")).toThrow(/after the start/i);
  });
  it("formats durations compactly", () => {
    expect(formatMinutes(45)).toBe("45 m");
    expect(formatMinutes(90)).toBe("1 h 30 m");
    expect(formatMinutes(120)).toBe("2 h");
  });
  it("groups appointments by org-timezone day, Today first", () => {
    const groups = groupAppointmentsByDay(
      [
        { id: "a", title: "Later", status: "CONFIRMED", startsAt: "2026-10-04T15:00:00.000Z", endsAt: "2026-10-04T16:00:00.000Z", jobTitle: null, locationLabel: null },
        { id: "b", title: "Today", status: "CONFIRMED", startsAt: "2026-10-03T09:00:00.000Z", endsAt: "2026-10-03T10:00:00.000Z", jobTitle: "J", locationLabel: "L" },
      ],
      "UTC",
      new Date("2026-10-03T10:00:00.000Z"),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.isToday).toBe(true);
    expect(groups[0]!.items[0]!.title).toBe("Today");
  });
});

describe("Nav visibility rule", () => {
  const techPerms = ["JOB_READ", "JOB_STATUS_UPDATE", "SCHEDULE_READ", "TIME_READ", "TIME_CREATE"] as const;
  it("technicians see only the scoped My … views", () => {
    const hrefs = visibleNavItems(NAV_ITEMS, [...techPerms], "TECHNICIAN").map((i) => i.href);
    expect(hrefs).toEqual(["my-schedule", "my-jobs", "my-time"]);
  });
  it("office staff keep the org-wide views and never see the My … items", () => {
    const hrefs = visibleNavItems(NAV_ITEMS, ["JOB_READ", "SCHEDULE_READ", "CUSTOMER_READ", "TIME_READ"], "OFFICE_STAFF").map((i) => i.href);
    expect(hrefs).toContain("jobs");
    expect(hrefs).toContain("schedule");
    expect(hrefs).not.toContain("my-jobs");
  });
});
