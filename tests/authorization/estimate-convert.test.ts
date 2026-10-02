/**
 * Action-level permission gate + cross-tenant rejection for
 * convertEstimateToJob (src/features/estimates/server/estimate.actions.ts).
 *
 * IN-MEMORY ONLY, mirroring tests/authorization/estimate-actions.test.ts: the
 * requirePermission seam and the shared Prisma db singleton are replaced with
 * bun:test `mock.module()` fakes (bun's runner ignores vi.mock, and vitest
 * cannot resolve bun:test — this file is excluded in vitest.config.ts and runs
 * under `bun test`, the project gate).
 *
 * What this proves at the ACTION layer (not just the repo layer):
 * - the conversion is gated on JOB_CREATE (primary) AND ESTIMATE_READ — both
 *   independently reject with FORBIDDEN and write nothing;
 * - a cross-tenant estimate id returns a user-safe `ok: false` NOT_FOUND and
 *   creates no job, no linked-job association, and no audit row;
 * - a successful conversion writes exactly one Job-CREATE audit row in the
 *   same transaction, with convertedFromEstimateId in the metadata.
 *
 * NOTE: @/server/audit is deliberately NOT mocked (mirroring the invoice/
 * estimate/payment action suites): bun's mock.module registrations leak across
 * test files in a full `bun test` run, and a closure-based audit mock would
 * capture THIS file's state array for other suites. The REAL writeAuditLog
 * routes through the db fake's auditLog.create below instead.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ForbiddenError } from "@/lib/errors";

const ORG_A = "org-local-a";
// Fixture ids are cuid-shaped: the payload is validated by zod's cuid.
const CUST_A = "custA000000000000000000001a";
const CUST_B = "custB000000000000000000001b";
const EST_A = "cestA00000000000000000001a";
const EST_B = "cestB00000000000000000001b";
const USER_ID = "user-local-1";
/** The auth context the mocked requirePermission resolves to (a member of ORG_A). */
const authContext = {
  organizationId: ORG_A,
  userId: USER_ID,
  clerkUserId: "clerk-user-1",
  membership: { role: "OWNER", isActive: true },
  organization: { slug: "acme", name: "Acme", timezone: "UTC", currency: "USD" },
};
/** Permissions the fake requirePermission will grant ("*" = owner with all). */
let grantedPermissions: readonly string[] = ["*"];
mock.module("@/server/auth/require-org", () => ({
  requireOrg: async () => authContext,
  requirePermission: async (permission: string) => {
    if (!grantedPermissions.includes("*") && !grantedPermissions.includes(permission)) {
      throw new ForbiddenError(`Missing permission: ${permission}`);
    }
    return authContext;
  },
  requireRole: async () => authContext,
}));
mock.module("next/cache", () => ({
  revalidatePath: () => {},
}));

/** In-memory Customer/Estimate/Job/Location tables + role-permission overrides. */
const state = {
  customers: [] as Array<Record<string, any>>,
  estimates: [] as Array<Record<string, any>>,
  jobs: [] as Array<Record<string, any>>,
  locations: [] as Array<Record<string, any>>,
  rolePermissionRows: [] as Array<Record<string, any>>,
  audit: [] as Array<Record<string, any>>,
};
function resetState() {
  state.customers = [
    { id: CUST_A, organizationId: ORG_A },
    { id: CUST_B, organizationId: "org-foreign" },
  ];
  state.estimates = [
    {
      id: EST_A, organizationId: ORG_A, customerId: CUST_A, jobId: null, estimateNumber: 2, status: "ACCEPTED",
      title: "Water heater swap", subtotalCents: 180000, taxCents: 14400, totalCents: 194400,
    },
    {
      id: EST_B, organizationId: "org-foreign", customerId: CUST_B, jobId: null, estimateNumber: 99, status: "ACCEPTED",
      title: "Foreign estimate", subtotalCents: 1, taxCents: 0, totalCents: 1,
    },
  ];
  state.jobs = [];
  state.locations = [{ id: "clocA0000000000000000001a", organizationId: ORG_A, customerId: CUST_A }];
  state.rolePermissionRows = [];
  state.audit = [];
}
function match(where: any, rows: Array<Record<string, any>>): Array<Record<string, any>> {
  return rows.filter((row) => {
    if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.customerId !== undefined && row.customerId !== where.customerId) return false;
    if (where.estimateId !== undefined && row.estimateId !== where.estimateId) return false;
    return true;
  });
}
mock.module("@/server/db/client", () => {
  const db: Record<string, any> = {
    // pg advisory lock (job number allocation) — recorded, no result set.
    $executeRaw: async () => 0,
    rolePermission: {
      // Per-org override rows REPLACE the role's built-in defaults (permissions.ts).
      findMany: async ({ where, select }: any) => {
        const rows = state.rolePermissionRows.filter(
          (row) => row.organizationId === where.organizationId && row.role === where.role,
        );
        return select?.permission ? rows.map((row) => ({ permission: row.permission })) : rows;
      },
    },
    customer: {
      findFirst: async ({ where }: any) => match(where, state.customers)[0] ?? null,
    },
    location: {
      findFirst: async ({ where }: any) => match(where, state.locations)[0] ?? null,
      findMany: async ({ where }: any) => match(where, state.locations),
    },
    estimate: {
      findFirst: async ({ where }: any) => match(where, state.estimates)[0] ?? null,
      updateMany: async ({ where, data }: any) => {
        const row = state.estimates.find(
          (estimate) => estimate.id === where.id && estimate.organizationId === where.organizationId,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    job: {
      findFirst: async ({ where, orderBy }: any) => {
        const matches = match(where, state.jobs);
        const row = orderBy?.jobNumber === "desc"
          ? [...matches].sort((a, b) => Number(b.jobNumber) - Number(a.jobNumber))[0]
          : matches[0];
        return row ?? null;
      },
      create: async ({ data }: any) => {
        const created = {
          id: `cjobA00000000000000000001${state.jobs.length + 1}`,
          leadId: null,
          priority: "NORMAL",
          description: null,
          actualRevenueCents: null,
          ...data,
        };
        state.jobs.push(created);
        return created;
      },
      update: async ({ where, data }: any) => {
        const row = state.jobs.find(
          (job) => job.id === where.id_organizationId.id && job.organizationId === where.id_organizationId.organizationId,
        );
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        state.audit.push(data);
        return data;
      },
    },
  };
  // A real Prisma TransactionClient has the models but NO $transaction — the tx
  // handed to the repo must not re-trigger the client-mode $transaction wrap.
  const txClient: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(db)) {
    if (key !== "$transaction") txClient[key] = value;
  }
  db.$transaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(txClient);
  return { db };
});

// Import the module under test AFTER the mocks are registered.
const { convertEstimateToJob } = await import("@/features/estimates/server/estimate.actions");

beforeEach(() => {
  resetState();
  grantedPermissions = ["*"];
  authContext.membership.role = "OWNER";
});

describe("convertEstimateToJob — permission gate", () => {
  it("rejects without JOB_CREATE and writes nothing", async () => {
    grantedPermissions = ["ESTIMATE_READ", "ESTIMATE_UPDATE"];
    const result = await convertEstimateToJob({ id: EST_A });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(state.jobs).toHaveLength(0);
    expect(state.estimates[0]!.jobId).toBeNull();
    expect(state.audit).toHaveLength(0);
  });

  it("rejects without ESTIMATE_READ (role override replaces the defaults)", async () => {
    // TECHNICIAN with a per-org override granting ONLY JOB_CREATE: the primary
    // gate passes, but the estimate read permission is still required.
    grantedPermissions = ["JOB_CREATE"];
    authContext.membership.role = "TECHNICIAN";
    state.rolePermissionRows = [{ organizationId: ORG_A, role: "TECHNICIAN", permission: "JOB_CREATE" }];
    const result = await convertEstimateToJob({ id: EST_A });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(state.jobs).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
});

describe("convertEstimateToJob — cross-tenant + lifecycle rejection", () => {
  it("rejects another org's estimate with NOT_FOUND and writes nothing", async () => {
    const result = await convertEstimateToJob({ id: EST_B });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    expect(state.jobs).toHaveLength(0);
    expect(state.estimates.find((estimate) => estimate.id === EST_B)!.jobId).toBeNull();
    expect(state.audit).toHaveLength(0);
  });

  it("rejects a non-ACCEPTED estimate and creates nothing", async () => {
    state.estimates[0]!.status = "SENT";
    const result = await convertEstimateToJob({ id: EST_A });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    expect(state.jobs).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
});

describe("convertEstimateToJob — happy path + audit", () => {
  it("creates the job from the estimate, links both ways, and audits one Job CREATE row in-transaction", async () => {
    const result = await convertEstimateToJob({ id: EST_A });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`convert failed: ${result.error.message}`);
    expect(state.jobs).toHaveLength(1);
    const job = state.jobs[0]!;
    expect(job.jobNumber).toBe(1); // next org-local number under the advisory lock
    expect(job.customerId).toBe(CUST_A);
    expect(job.title).toBe("Water heater swap");
    expect(job.type).toBe("SERVICE_CALL");
    expect(job.status).toBe("DRAFT");
    expect(job.quotedAmountCents).toBe(194400);
    expect(job.subtotalCents).toBe(180000);
    expect(job.taxCents).toBe(14400);
    expect(job.totalCents).toBe(194400);
    expect(job.locationId).toBe("clocA0000000000000000001a"); // exactly one customer location
    expect(job.estimateId).toBe(EST_A); // conversion marker
    expect(state.estimates[0]!.jobId).toBe(job.id); // "Linked job" association
    expect(result.data.jobId).toBe(job.id);
    expect(result.data.jobNumber).toBe(1);

    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]!.entityType).toBe("Job");
    expect(state.audit[0]!.action).toBe("CREATE");
    expect(state.audit[0]!.entityId).toBe(job.id);
    expect(state.audit[0]!.metadata).toEqual({ convertedFromEstimateId: EST_A });
    expect(state.audit[0]!.actorUserId).toBe(USER_ID);
  });

  it("refuses a second conversion of the same estimate (no duplicate job or audit row)", async () => {
    const first = await convertEstimateToJob({ id: EST_A });
    expect(first.ok).toBe(true);
    const second = await convertEstimateToJob({ id: EST_A });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("CONFLICT");
    expect(state.jobs).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
  });
});
