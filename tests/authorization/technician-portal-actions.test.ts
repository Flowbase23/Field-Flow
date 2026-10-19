/**
 * Action-level permission gates + self-scoping for logTimeEntry
 * (src/features/technician-portal/server/time-entry.actions.ts).
 *
 * IN-MEMORY ONLY, mirroring tests/authorization/payment-actions.test.ts: the
 * requirePermission seam and the shared Prisma db singleton are replaced with
 * bun:test mock.module() fakes (excluded in vitest.config.ts; runs under
 * `bun test`, the project gate). @/server/audit is NOT mocked — the real
 * writeAuditLog lands in the fake db's auditLog.create (bun mock.module leaks
 * across files, so a closure-based audit mock is forbidden here).
 *
 * Proven at the ACTION layer:
 * - TIME_CREATE is re-gated (no grant → FORBIDDEN, nothing written);
 * - a user without a Technician record gets NOT_FOUND ("not set up as a
 *   technician");
 * - the stored technicianId is ALWAYS the session user's own technician record
 *   (self-scoping is server-derived, never client-supplied);
 * - a cross-tenant job id → user-safe NOT_FOUND, no row, no audit;
 * - the duration is server-derived (client sends hours/span, never minutes).
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ForbiddenError } from "@/lib/errors";

const ORG_A = "org-local-a";
const JOB_A = "cjobA000000000000000000001a";
const JOB_B = "cjobB000000000000000000001b";
const USER_ID = "user-local-1";
const TECH_SELF = "ctechA000000000000000000001a";
const authContext = {
  organizationId: ORG_A,
  userId: USER_ID,
  clerkUserId: "clerk-user-1",
  membership: { role: "TECHNICIAN", isActive: true },
  organization: { slug: "acme", name: "Acme", timezone: "UTC", currency: "USD" },
};
let grantedPermissions: readonly string[] = ["TIME_CREATE"];
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
mock.module("next/cache", () => ({ revalidatePath: () => {} }));

const state = {
  technicians: [] as Array<Record<string, any>>,
  jobs: [] as Array<Record<string, any>>,
  assignments: [] as Array<Record<string, any>>,
  entries: [] as Array<Record<string, any>>,
  audit: [] as Array<Record<string, any>>,
};
function resetState() {
  state.technicians = [{ id: TECH_SELF, organizationId: ORG_A, userId: USER_ID, isActive: true }];
  state.jobs = [
    { id: JOB_A, organizationId: ORG_A, jobNumber: 3, title: "Furnace swap" },
    { id: JOB_B, organizationId: "org-foreign", jobNumber: 99, title: "Foreign" },
  ];
  state.assignments = [{ jobId: JOB_A, technicianId: TECH_SELF, organizationId: ORG_A }];
  state.entries = [];
  state.audit = [];
}
mock.module("@/server/db/client", () => {
  function find(rows: Array<Record<string, any>>, where: any) {
    return rows.find((row) => Object.entries(where).every(([k, v]) => row[k] === v)) ?? null;
  }
  const db: Record<string, any> = {
    technician: { findFirst: async ({ where }: any) => find(state.technicians, where) },
    job: { findFirst: async ({ where }: any) => find(state.jobs, where) },
    jobTechnician: { findFirst: async ({ where }: any) => find(state.assignments, where) },
    timeEntry: {
      findFirst: async ({ where }: any) => find(state.entries, where),
      findMany: async ({ where }: any) => state.entries.filter((row) => Object.entries(where).every(([k, v]) => row[k] === v)),
      create: async ({ data }: any) => {
        const created = { id: `centryA000000000000000000001${state.entries.length + 1}`, endedAt: null, ...data };
        state.entries.push(created);
        return created;
      },
    },
    auditLog: { create: async ({ data }: any) => (state.audit.push(data), data) },
  };
  const txClient: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(db)) if (key !== "$transaction") txClient[key] = value;
  db.$transaction = async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(txClient);
  return { db };
});

const { logTimeEntry } = await import("@/features/technician-portal/server/time-entry.actions");

beforeEach(() => {
  resetState();
  grantedPermissions = ["TIME_CREATE"];
});

describe("logTimeEntry", () => {
  it("requires TIME_CREATE", async () => {
    grantedPermissions = [];
    const result = await logTimeEntry({ workDate: "2026-10-03", hours: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(state.entries).toHaveLength(0);
  });
  it("rejects a user who is not a technician", async () => {
    state.technicians = [];
    const result = await logTimeEntry({ workDate: "2026-10-03", hours: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    expect(state.entries).toHaveLength(0);
  });
  it("logs hours as the SELF technician and audits the write", async () => {
    const result = await logTimeEntry({ jobId: JOB_A, workDate: "2026-10-03", hours: 1.5, billable: true });
    expect(result.ok).toBe(true);
    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0]!;
    expect(entry.technicianId).toBe(TECH_SELF); // server-derived, never client-supplied
    expect(entry.minutes).toBe(90);
    expect(entry.jobId).toBe(JOB_A);
    expect(state.audit.some((row) => row.entityType === "TimeEntry" && row.action === "CREATE")).toBe(true);
  });
  it("derives minutes from the start/end span server-side", async () => {
    const result = await logTimeEntry({ jobId: JOB_A, workDate: "2026-10-03", startTime: "09:00", endTime: "10:30" });
    expect(result.ok).toBe(true);
    expect(state.entries[0]!.minutes).toBe(90);
    expect(state.entries[0]!.endedAt).toBeInstanceOf(Date);
  });
  it("rejects zero hours before any write", async () => {
    const result = await logTimeEntry({ workDate: "2026-10-03", hours: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    expect(state.entries).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
  it("returns a user-safe NOT_FOUND for a cross-tenant job and writes nothing", async () => {
    const result = await logTimeEntry({ jobId: JOB_B, workDate: "2026-10-03", hours: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    expect(state.entries).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
  it("rejects logging against a job the technician is not assigned to", async () => {
    state.assignments = [];
    const result = await logTimeEntry({ jobId: JOB_A, workDate: "2026-10-03", hours: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/assigned/i);
    expect(state.entries).toHaveLength(0);
  });
});
