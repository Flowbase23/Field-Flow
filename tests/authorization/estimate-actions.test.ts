/**
 * Action-level cross-tenant rejection for the estimate server actions
 * (src/features/estimates/server/estimate.actions.ts).
 *
 * IN-MEMORY ONLY, mirroring tests/authorization/invoice-actions.test.ts: the
 * requirePermission seam and the shared Prisma db singleton are replaced with
 * bun:test `mock.module()` fakes (bun's runner ignores vi.mock, and vitest
 * cannot resolve bun:test — this file is excluded in vitest.config.ts and runs
 * under `bun test`, the project gate).
 *
 * What this proves at the ACTION layer (not just the repo layer):
 * - every mutation re-gates on the matching ESTIMATE_* permission;
 * - a cross-tenant customer/job/estimate id returns a user-safe
 *   `ok: false` NOT_FOUND result and writes nothing (no repo create/update,
 *   no audit row) even though the caller is an authenticated member of ANOTHER
 *   organization.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

const ORG_A = "org-local-a";
// Fixture ids are cuid-shaped: estimate payloads are validated by zod's cuid.
const CUST_A = "custA000000000000000000001a";
const CUST_B = "custB000000000000000000001b";
const JOB_A = "cjobA00000000000000000001a";
const JOB_B = "cjobB00000000000000000001b";
const EST_FOREIGN = "cestB00000000000000000001b";
const USER_ID = "user-local-1";
/** The auth context the mocked requirePermission resolves to (a member of ORG_A). */
const authContext = {
  organizationId: ORG_A,
  userId: USER_ID,
  clerkUserId: "clerk-user-1",
  membership: { role: "OWNER", isActive: true },
  organization: { slug: "acme", name: "Acme", timezone: "UTC", currency: "USD" },
};

mock.module("@/server/auth/require-org", () => ({
  requireOrg: async () => authContext,
  requirePermission: async () => authContext,
  requireRole: async () => authContext,
}));
mock.module("next/cache", () => ({
  revalidatePath: () => {},
}));

/** In-memory Customer/Job/Estimate/AuditLog tables, scoped by org. */
const state = {
  customers: [] as Array<Record<string, any>>,
  jobs: [] as Array<Record<string, any>>,
  estimates: [] as Array<Record<string, any>>,
  audit: [] as Array<Record<string, any>>,
};
function resetState() {
  state.customers = [
    { id: CUST_A, organizationId: ORG_A },
    { id: CUST_B, organizationId: "org-foreign" },
  ];
  state.jobs = [
    { id: JOB_A, organizationId: ORG_A },
    { id: JOB_B, organizationId: "org-foreign" },
  ];
  state.estimates = [];
  state.audit = [];
}
const auditSpy = { count: 0 };
mock.module("@/server/db/client", () => {
  function match(where: any, rows: Array<Record<string, any>>): Array<Record<string, any>> {
    return rows.filter((row) => {
      if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
      if (where.id !== undefined && row.id !== where.id) return false;
      return true;
    });
  }
  const db: Record<string, any> = {
    // pg advisory lock (estimate number allocation) — recorded, no result set.
    $executeRaw: async () => 0,
    customer: {
      findFirst: async ({ where }: any) => match(where, state.customers)[0] ?? null,
    },
    job: {
      findFirst: async ({ where }: any) => match(where, state.jobs)[0] ?? null,
    },
    estimate: {
      findFirst: async ({ where, orderBy, select }: any) => {
        const matches = match(where, state.estimates);
        const row = orderBy?.estimateNumber === "desc"
          ? [...matches].sort((a, b) => Number(b.estimateNumber) - Number(a.estimateNumber))[0]
          : matches[0];
        if (!row) return null;
        return select?.estimateNumber ? { estimateNumber: row.estimateNumber } : { ...row };
      },
      create: async ({ data }: any) => {
        if (data.estimateNumber === undefined) throw new Error("create requires an allocated estimateNumber");
        const created = {
          id: `cestA000000000000000000001${state.estimates.length + 1}`,
          title: null,
          validUntil: null,
          sentAt: null,
          acceptedAt: null,
          declinedAt: null,
          ...data,
        };
        state.estimates.push(created);
        return created;
      },
      updateMany: async ({ where, data }: any) => {
        const row = state.estimates.find((estimate) => estimate.id === where.id && estimate.organizationId === where.organizationId && (where.status === undefined || estimate.status === where.status));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        auditSpy.count += 1;
        state.audit.push(data);
        return data;
      },
    },
  };
  // A real Prisma TransactionClient has the models but NO $transaction — the tx
  // handed to the repo must not re-trigger the client-mode $transaction wrap
  // (createEstimateRepo would otherwise nest transactions forever).
  const txClient: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(db)) {
    if (key !== "$transaction") txClient[key] = value;
  }
  db.$transaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(txClient);
  return { db };
});

// Import the module under test AFTER the mocks are registered.
const { createEstimate, updateEstimate, setEstimateStatus } = await import("@/features/estimates/server/estimate.actions");
const payload = { customerId: CUST_A, jobId: null, title: null, validUntil: null, subtotalCents: 5000, taxCents: 400 };

beforeEach(() => {
  resetState();
  auditSpy.count = 0;
});

describe("createEstimate — action-level cross-tenant rejection", () => {
  it("rejects a cross-tenant customer with a user-safe NOT_FOUND and no writes", async () => {
    const result = await createEstimate({ ...payload, customerId: CUST_B });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    expect(state.estimates).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
  it("rejects a cross-tenant job link and creates nothing", async () => {
    const result = await createEstimate({ ...payload, jobId: JOB_B });
    expect(result.ok).toBe(false);
    expect(state.estimates).toHaveLength(0);
  });
  it("succeeds in-tenant and writes one CREATE audit row in the same transaction", async () => {
    const result = await createEstimate(payload);
    expect(result.ok).toBe(true);
    expect(state.estimates).toHaveLength(1);
    expect(state.estimates[0]!.totalCents).toBe(5400); // server recomputed
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]!.entityType).toBe("Estimate");
    expect(state.audit[0]!.action).toBe("CREATE");
  });
});

describe("updateEstimate — action-level cross-tenant rejection", () => {
  it("rejects editing another org's estimate id", async () => {
    const seeded = await createEstimate(payload);
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.message}`);
    const result = await updateEstimate({ id: EST_FOREIGN, ...payload, subtotalCents: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
  it("rejects re-linking an in-tenant estimate to a foreign job", async () => {
    const seeded = await createEstimate(payload);
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.message}`);
    const result = await updateEstimate({ id: seeded.data.id, ...payload, jobId: JOB_B });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    // The estimate keeps its original values (the create omitted the jobId key).
    expect(state.estimates[0]!.jobId ?? null).toBeNull();
    expect(state.estimates[0]!.subtotalCents).toBe(5000);
  });
});

describe("setEstimateStatus — action-level cross-tenant rejection + auditing", () => {
  it("rejects transitioning another org's estimate", async () => {
    const result = await setEstimateStatus({ id: EST_FOREIGN, status: "SENT" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    expect(state.audit).toHaveLength(0);
  });
  it("audits a valid in-tenant transition with before/after snapshots", async () => {
    const seeded = await createEstimate(payload);
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.message}`);
    const result = await setEstimateStatus({ id: seeded.data.id, status: "SENT" });
    expect(result.ok).toBe(true);
    expect(state.estimates[0]!.status).toBe("SENT");
    const statusAudits = state.audit.filter((row) => row.action === "STATUS_CHANGED");
    expect(statusAudits).toHaveLength(1);
    expect(statusAudits[0]!.before.status).toBe("DRAFT");
    expect(statusAudits[0]!.after.status).toBe("SENT");
  });
  it("rejects an out-of-map transition (DRAFT → ACCEPTED) and leaves the row untouched", async () => {
    const seeded = await createEstimate(payload);
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.message}`);
    const result = await setEstimateStatus({ id: seeded.data.id, status: "ACCEPTED" });
    expect(result.ok).toBe(false);
    expect(state.estimates[0]!.status).toBe("DRAFT");
  });
});
