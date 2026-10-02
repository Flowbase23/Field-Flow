/**
 * Estimate → Job conversion (Phase 2 Slice P2-2 follow-up) — repository guards
 * and server-derived mapping, exercised against a small Prisma-shaped fake.
 * Action-level permission/audit/tenant seams live in
 * tests/authorization/estimate-convert.test.ts (bun).
 *
 * What this proves at the REPO layer:
 * - the job copies the estimate's customer/title/money and takes the next
 *   org-local job number under the per-org advisory lock (same scheme as
 *   manual creation), starts in DRAFT, and is stamped with Job.estimateId;
 * - the estimate's user-facing "Linked job" (Estimate.jobId) is set too;
 * - the service location is linked only when the customer has EXACTLY one;
 * - only ACCEPTED estimates convert, and only once (pre-check + P2002 mapping);
 * - cross-tenant estimate ids are rejected before any write.
 */
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { createJobRepo } from "@/server/repositories/job.repo";

const ORG_A = "org-a";
const ORG_B = "org-b";
const CUSTOMER_A = "customer-a";
const CUSTOMER_B = "customer-b";
const LOCATION_A = "location-a";
const LOCATION_A2 = "location-a-2";

interface FakeEstimate {
  id: string;
  organizationId: string;
  customerId: string;
  jobId: string | null;
  status: string;
  title: string | null;
  estimateNumber: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}
interface FakeJob {
  id: string;
  organizationId: string;
  customerId: string;
  locationId: string | null;
  estimateId?: string | null;
  jobNumber: number;
  status?: string;
  [key: string]: unknown;
}

function makeEstimate(overrides: Partial<FakeEstimate> = {}): FakeEstimate {
  return {
    id: "est-accepted",
    organizationId: ORG_A,
    customerId: CUSTOMER_A,
    jobId: null,
    status: "ACCEPTED",
    title: "AC replacement",
    estimateNumber: 3,
    subtotalCents: 12000,
    taxCents: 960,
    totalCents: 12960,
    ...overrides,
  };
}

function makePrisma(options: { locations?: Array<{ id: string; organizationId: string; customerId: string }>; estimates?: FakeEstimate[]; breakStampWith?: "P2002" } = {}) {
  const locations = options.locations ?? [{ id: LOCATION_A, organizationId: ORG_A, customerId: CUSTOMER_A }];
  const estimates: FakeEstimate[] = options.estimates ?? [makeEstimate()];
  const jobs: FakeJob[] = [
    { id: "job-old-a", organizationId: ORG_A, customerId: CUSTOMER_A, locationId: LOCATION_A, jobNumber: 7, status: "DRAFT" },
    { id: "job-old-b", organizationId: ORG_B, customerId: CUSTOMER_B, locationId: "location-b", jobNumber: 99, status: "DRAFT" },
  ];
  const locks = vi.fn().mockResolvedValue([]);

  const prisma = {
    $executeRaw: locks,
    customer: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; organizationId: string } }) =>
        [ ...[{ id: CUSTOMER_A, organizationId: ORG_A }, { id: CUSTOMER_B, organizationId: ORG_B }] ].find(
          (row) => row.id === where.id && row.organizationId === where.organizationId,
        ) ?? null,
      ),
    },
    location: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; organizationId: string } }) =>
        locations.find((row) => row.id === where.id && row.organizationId === where.organizationId) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { customerId?: string; organizationId: string } }) =>
        locations.filter((row) => row.organizationId === where.organizationId && row.customerId === where.customerId),
      ),
    },
    lead: { findFirst: vi.fn(async () => null) },
    estimate: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; organizationId: string } }) =>
        estimates.find((row) => row.organizationId === where.organizationId && (!where.id || row.id === where.id)) ?? null,
      ),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; organizationId: string }; data: Record<string, unknown> }) => {
        const row = estimates.find((estimate) => estimate.id === where.id && estimate.organizationId === where.organizationId);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    job: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: { id?: string; organizationId: string; estimateId?: string }; orderBy?: unknown }) => {
        const matches = jobs.filter((row) => {
          if (row.organizationId !== where.organizationId) return false;
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.estimateId !== undefined && row.estimateId !== where.estimateId) return false;
          return true;
        });
        if (orderBy && (orderBy as { jobNumber?: string }).jobNumber === "desc") {
          return [...matches].sort((a, b) => Number(b.jobNumber) - Number(a.jobNumber))[0] ?? null;
        }
        return matches[0] ?? null;
      }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => jobs.length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `job-new-${jobs.length}`, status: "DRAFT", ...data } as FakeJob;
        jobs.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: { where: { id_organizationId: { id: string; organizationId: string } }; data: Record<string, unknown> }) => {
        if (options.breakStampWith === "P2002") {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
        }
        const row = jobs.find((job) => job.id === where.id_organizationId.id && job.organizationId === where.id_organizationId.organizationId);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; organizationId: string }; data: Record<string, unknown> }) => {
        const row = jobs.find((job) => job.id === where.id && job.organizationId === where.organizationId);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  return { prisma, locks, jobs, estimates };
}

describe("Job repo createFromEstimate — server-derived mapping", () => {
  it("copies the accepted estimate into a new org-locally-numbered DRAFT job and stamps provenance both ways", async () => {
    const { prisma, locks, jobs, estimates } = makePrisma();
    const created = await createJobRepo(prisma as never, ORG_A).createFromEstimate("est-accepted");

    expect(locks).toHaveBeenCalledTimes(1); // same advisory-lock scheme as manual creation
    expect(created.jobNumber).toBe(8); // org-b's #99 is not visible to org-a allocation
    expect(created.status).toBe("DRAFT");
    expect(created.customerId).toBe(CUSTOMER_A);
    expect(created.title).toBe("AC replacement");
    expect(created.type).toBe("SERVICE_CALL"); // conservative default; estimates carry no type
    expect(created.quotedAmountCents).toBe(12960); // the accepted quote = estimate total
    expect(created.subtotalCents).toBe(12000);
    expect(created.taxCents).toBe(960);
    expect(created.totalCents).toBe(12960);
    expect(created.estimateId).toBe("est-accepted"); // conversion marker on the job
    expect(estimates[0]!.jobId).toBe(created.id); // user-facing "Linked job" association
    expect(created.locationId).toBe(LOCATION_A); // customer has exactly one location
    expect(jobs).toHaveLength(3);
  });

  it("falls back to 'Estimate #N' when the estimate has no usable title", async () => {
    const { prisma } = makePrisma({ estimates: [makeEstimate({ title: "   " })] });
    const created = await createJobRepo(prisma as never, ORG_A).createFromEstimate("est-accepted");
    expect(created.title).toBe("Estimate #3");
  });

  it("leaves the job location-less when the customer has zero or several locations", async () => {
    const zero = makePrisma({ locations: [] });
    const createdZero = await createJobRepo(zero.prisma as never, ORG_A).createFromEstimate("est-accepted");
    expect(createdZero.locationId ?? null).toBeNull();

    const several = makePrisma({
      locations: [
        { id: LOCATION_A, organizationId: ORG_A, customerId: CUSTOMER_A },
        { id: LOCATION_A2, organizationId: ORG_A, customerId: CUSTOMER_A },
      ],
    });
    const createdSeveral = await createJobRepo(several.prisma as never, ORG_A).createFromEstimate("est-accepted");
    expect(createdSeveral.locationId ?? null).toBeNull();
  });

  it("never derives a location across tenants", async () => {
    // The customer's locations are queried with the org predicate; a foreign
    // location row with the same customer id must not leak into the job.
    const { prisma } = makePrisma({
      locations: [{ id: "location-b", organizationId: ORG_B, customerId: CUSTOMER_A }],
    });
    const created = await createJobRepo(prisma as never, ORG_A).createFromEstimate("est-accepted");
    expect(created.locationId ?? null).toBeNull();
  });
});

describe("Job repo createFromEstimate — conversion guards", () => {
  it("rejects a second conversion of the same estimate and creates nothing", async () => {
    const { prisma, jobs } = makePrisma();
    const first = await createJobRepo(prisma as never, ORG_A).createFromEstimate("est-accepted");
    const before = jobs.length;
    await expect(createJobRepo(prisma as never, ORG_A).createFromEstimate("est-accepted")).rejects.toBeInstanceOf(ConflictError);
    expect(jobs).toHaveLength(before);
    expect(jobs.find((job) => job.estimateId === "est-accepted")!.id).toBe(first.id); // still only the first job
  });

  it("rejects a non-ACCEPTED estimate without creating a job", async () => {
    const { prisma, jobs } = makePrisma({ estimates: [makeEstimate({ status: "SENT" })] });
    await expect(createJobRepo(prisma as never, ORG_A).createFromEstimate("est-accepted")).rejects.toThrow("Only accepted estimates");
    expect(jobs).toHaveLength(2); // only the two seed rows — nothing created
  });

  it("rejects an estimate id from another tenant and writes nothing", async () => {
    const { prisma, jobs, estimates } = makePrisma({
      estimates: [makeEstimate({ id: "est-foreign", organizationId: ORG_B, customerId: CUSTOMER_B, status: "ACCEPTED" })],
    });
    await expect(createJobRepo(prisma as never, ORG_A).createFromEstimate("est-foreign")).rejects.toBeInstanceOf(NotFoundError);
    expect(jobs).toHaveLength(2);
    expect(estimates.find((estimate) => estimate.id === "est-foreign")!.jobId).toBeNull();
  });

  it("maps a unique-index violation on the provenance stamp to ConflictError (concurrent double-convert backstop)", async () => {
    const { prisma, estimates } = makePrisma({ breakStampWith: "P2002" });
    // In-memory fakes cannot emulate row rollback (that is the transaction's
    // job on live Postgres) — the job create has already happened here. What
    // this proves at the application layer: the losing convert surfaces as a
    // ConflictError and none of the writes AFTER the failed stamp (the
    // estimate's linked-job association) are applied.
    await expect(createJobRepo(prisma as never, ORG_A).createFromEstimate("est-accepted")).rejects.toBeInstanceOf(ConflictError);
    expect(estimates[0]!.jobId).toBeNull();
  });

  it("opens a transaction when composed from a Prisma client (audit shares the tx)", async () => {
    const { prisma } = makePrisma();
    const tx = { $executeRaw: prisma.$executeRaw, customer: prisma.customer, location: prisma.location, lead: prisma.lead, estimate: prisma.estimate, job: prisma.job };
    const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
    Object.assign(prisma, { $transaction: transaction });

    await createJobRepo(prisma as never, ORG_A).createFromEstimate("est-accepted");
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
