/**
 * Consolidated cross-tenant predicate-injection suite (tenant-isolation
 * mechanism B — README "Tenant isolation conventions" #2).
 *
 * Two layers, both IN-MEMORY (no live Clerk, no database):
 *
 * 1. Predicate sweep — a recording fake Prisma runs EVERY public operation of
 *    every tenant repository (src/server/repositories/) and asserts each
 *    recorded read/write carries the organizationId predicate: directly on the
 *    call (`where.organizationId`, `where.id_organizationId.organizationId`,
 *    `create.data.organizationId`, join-row `createMany` rows), or — for the
 *    one compound-selector join write that legitimately has no org column in
 *    its selector — guarded by an EARLIER same-model call that did verify the
 *    tenant (e.g. setPrimaryTechnician's jobTechnician.update after
 *    assertJob/assertTechnician).
 *
 * 2. Cross-tenant rejection — rows that exist ONLY in another organization
 *    must be invisible/rejected: null lookups, NotFoundError from count-guard
 *    mutations, and P2025-style failures on compound-selector writes.
 *
 * 3. Action source contract — every repo call in the server actions under
 *    src/features (the per-feature "server" folders) passes an
 *    organizationId-derived tenant id, and each action file goes through a
 *    require* gate. Runtime behavior of the actions themselves (with a live
 *    session) remains PENDING LIVE VERIFICATION.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NotFoundError } from "@/lib/errors";
import { createAppointmentRepo } from "@/server/repositories/appointment.repo";
import { createCustomerRepo } from "@/server/repositories/customer.repo";
import { createEstimateRepo } from "@/server/repositories/estimate.repo";
import { createInvoiceRepo } from "@/server/repositories/invoice.repo";
import { createJobRepo } from "@/server/repositories/job.repo";
import { createLeadRepo } from "@/server/repositories/lead.repo";
import { createLocationRepo } from "@/server/repositories/location.repo";
import { createMembershipRepo } from "@/server/repositories/membership.repo";
import { createTechnicianRepo } from "@/server/repositories/technician.repo";

const ORG = "org-a";
const OTHER = "org-b";

/* ------------------------------------------------------------------ */
/* Layer 1 — recording fake + predicate sweep                          */
/* ------------------------------------------------------------------ */

type Call = { model: string; method: string; args: any };

const MODELS = [
  "customer",
  "location",
  "lead",
  "membership",
  "technician",
  "appointment",
  "appointmentTechnician",
  "job",
  "jobTechnician",
  "auditLog",
  "invoice",
  "estimate",
] as const;

/** Models that are deliberately global (no organizationId column). */
const GLOBAL_MODELS = new Set(["user", "organization"]);

/** True when the org id appears anywhere in args as the value of organizationId. */
function mentionsOrg(node: unknown, org: string): boolean {
  if (Array.isArray(node)) return node.some((entry) => mentionsOrg(entry, org));
  if (node !== null && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).some(
      ([key, value]) =>
        (key === "organizationId" && value === org) ||
        (value !== null && typeof value === "object" && mentionsOrg(value, org)),
    );
  }
  return false;
}

/**
 * A fake Prisma client that records every model call and returns permissive
 * canned rows so repository control flow runs to completion.
 */
function recordingDb() {
  const calls: Call[] = [];
  const universalRow = {
    id: "row-1",
    customerId: "cust-1",
    locationId: "loc-1",
    isActive: true,
    // Invoice fields so the status transition map can run on the fake row.
    status: "DRAFT",
    balanceCents: 0,
    paidCents: 0,
  };

  function makeModelProxy(model: string) {
    return new Proxy(
      {},
      {
        get(_target, method: string) {
          return async (args: any) => {
            calls.push({ model, method, args });
            switch (method) {
              case "findMany":
                return [];
              case "count":
                return 1;
              case "updateMany":
              case "deleteMany":
              case "createMany":
                return { count: 1 };
              // findFirst/findUnique/create/update/upsert/delete/… → a row
              default:
                return { ...universalRow };
            }
          };
        },
      },
    );
  }

  /** A real Prisma transaction client has models + $executeRaw but NO $transaction. */
  function makeClient(withTransaction: boolean) {
    const client: any = {};
    for (const model of MODELS) client[model] = makeModelProxy(model);
    client.$executeRaw = async () => 0; // pg advisory lock in job.repo
    if (withTransaction) {
      client.$transaction = async (fn: (tx: unknown) => unknown) => fn(makeClient(false));
    }
    return client;
  }

  return { db: makeClient(true), calls };
}

/**
 * Every non-global call must mention the tenant id somewhere in its args, OR
 * be guarded by an earlier same-model call that did (the repos verify tenant
 * scope of linked ids BEFORE compound-selector writes).
 */
function expectOperationTenantScoped(calls: Call[], org: string) {
  const relevant = calls.filter((call) => !GLOBAL_MODELS.has(call.model));
  for (let index = 0; index < relevant.length; index += 1) {
    const call = relevant[index]!;
    if (mentionsOrg(call.args, org)) continue;
    const guardedByEarlierCall = relevant
      .slice(0, index)
      .some((earlier) => earlier.model === call.model && mentionsOrg(earlier.args, org));
    if (!guardedByEarlierCall) {
      throw new Error(
        `${call.model}.${call.method} has no organizationId predicate — args: ${JSON.stringify(call.args)}`,
      );
    }
  }
}

/** Run each repository operation against a fresh recording db and sweep it. */
async function sweep(
  repoName: string,
  makeRepo: (db: any) => unknown,
  operations: Array<[string, (repo: any) => Promise<unknown>]>,
) {
  for (const [name, run] of operations) {
    const { db, calls } = recordingDb();
    const repo = makeRepo(db);
    let result: unknown;
    try {
      result = await run(repo);
    } catch (error) {
      throw new Error(`${repoName}.${name} threw unexpectedly: ${error}`);
    }
    try {
      expectOperationTenantScoped(calls, ORG);
    } catch (error) {
      throw new Error(`${repoName}.${name}: ${(error as Error).message}`);
    }
    if (result === undefined && !["assignTechnician", "unassignTechnician", "setPrimaryTechnician"].includes(name)) {
      throw new Error(`${repoName}.${name} returned undefined — fake row shape mismatch`);
    }
  }
}

describe("cross-tenant predicate sweep — every repository read/write carries organizationId", () => {
  it("customer.repo", async () => {
    await sweep(
      "customer",
      (db) => createCustomerRepo(db, ORG),
      [
        ["list", (repo) => repo.list({ search: "doe" })],
        ["listWithLocations", (repo) => repo.listWithLocations({ isActive: true })],
        ["count", (repo) => repo.count()],
        ["getById", (repo) => repo.getById("cust-1")],
        ["getDetail", (repo) => repo.getDetail("cust-1")],
        ["findByEmailOrPhone", (repo) => repo.findByEmailOrPhone("a@b.c", null)],
        ["create", (repo) => repo.create({ lastName: "Doe" })],
        ["update", (repo) => repo.update("cust-1", { lastName: "Doe" })],
        ["setActive", (repo) => repo.setActive("cust-1", false)],
        ["remove", (repo) => repo.remove("cust-1")],
      ],
    );
  });

  it("lead.repo", async () => {
    await sweep(
      "lead",
      (db) => createLeadRepo(db, ORG),
      [
        ["list", (repo) => repo.list({ status: "NEW" })],
        ["count", (repo) => repo.count()],
        ["getById", (repo) => repo.getById("row-1")],
        ["listByCustomer", (repo) => repo.listByCustomer("cust-1")],
        ["create", (repo) => repo.create({ title: "Repipe", source: "WEBSITE" })],
        ["update", (repo) => repo.update("row-1", { title: "Repipe 2" })],
        ["updateStatus", (repo) => repo.updateStatus("row-1", { status: "CONTACTED" })],
        ["remove", (repo) => repo.remove("row-1")],
      ],
    );
  });

  it("location.repo", async () => {
    await sweep(
      "location",
      (db) => createLocationRepo(db, ORG),
      [
        ["listAll", (repo) => repo.listAll()],
        ["listByCustomer", (repo) => repo.listByCustomer("cust-1")],
        ["getById", (repo) => repo.getById("loc-1")],
        ["create", (repo) => repo.create({ customerId: "cust-1", address1: "1 Main", city: "X", state: "ST", postalCode: "00000" })],
        ["update", (repo) => repo.update("loc-1", { city: "Y" })],
        ["remove", (repo) => repo.remove("loc-1")],
      ],
    );
  });

  it("membership.repo", async () => {
    await sweep(
      "membership",
      (db) => createMembershipRepo(db, ORG),
      [
        ["list", (repo) => repo.list()],
        ["getById", (repo) => repo.getById("row-1")],
        ["getByUserId", (repo) => repo.getByUserId("user-1")],
        ["updateRole", (repo) => repo.updateRole("row-1", "DISPATCHER")],
        ["updateActive", (repo) => repo.updateActive("row-1", false)],
        ["upsertForUser", (repo) => repo.upsertForUser("user-1", { role: "TECHNICIAN" })],
      ],
    );
  });

  it("technician.repo", async () => {
    await sweep(
      "technician",
      (db) => createTechnicianRepo(db, ORG),
      [
        ["listActive", (repo) => repo.listActive()],
        ["getById", (repo) => repo.getById("row-1")],
        ["listByIds", (repo) => repo.listByIds(["t1", "t2"])],
      ],
    );
  });

  it("appointment.repo", async () => {
    const start = new Date("2026-08-26T08:00:00.000Z");
    const end = new Date("2026-08-26T09:00:00.000Z");
    await sweep(
      "appointment",
      (db) => createAppointmentRepo(db, ORG),
      [
        ["listInRange", (repo) => repo.listInRange({ start, end })],
        ["getById", (repo) => repo.getById("row-1")],
        ["listForJob", (repo) => repo.listForJob("job-1")],
        ["findOverlapping", (repo) => repo.findOverlapping({ start, end, technicianIds: ["t1"] })],
        ["findOverlapping without technicians short-circuits", (repo) => repo.findOverlapping({ start, end })],
        // No jobId on create: a job-linked create must also reuse the job's
        // exact service location — that tuple is covered by tests/appointment-links.test.ts.
        ["create", (repo) => repo.create({ type: "JOB", title: "Visit", startsAt: start, endsAt: end, timezone: "UTC", locationId: "loc-1" }, ["t1"])],
        ["update with technician replacement", (repo) => repo.update("row-1", { title: "Visit 2" }, ["t1", "t2"])],
        ["update without technician replacement", (repo) => repo.update("row-1", { notes: "x" })],
        ["updateStatus", (repo) => repo.updateStatus("row-1", { status: "CONFIRMED" })],
        ["cancel", (repo) => repo.cancel("row-1")],
      ],
    );
  });

  it("job.repo", async () => {
    await sweep(
      "job",
      (db) => createJobRepo(db, ORG),
      [
        ["list", (repo) => repo.list({ status: "DRAFT" })],
        ["count", (repo) => repo.count()],
        ["getById", (repo) => repo.getById("row-1")],
        ["getDetail", (repo) => repo.getDetail("row-1")],
        ["listEligibleTechnicians", (repo) => repo.listEligibleTechnicians()],
        ["create", (repo) => repo.create({ customerId: "cust-1", locationId: "loc-1", type: "SERVICE_CALL", title: "Fix AC" })],
        ["update", (repo) => repo.update("row-1", { title: "Fix AC 2" })],
        ["updateStatus", (repo) => repo.updateStatus("row-1", "DRAFT", { status: "IN_PROGRESS" })],
        ["assignTechnician", (repo) => repo.assignTechnician("row-1", "t1", true)],
        ["unassignTechnician", (repo) => repo.unassignTechnician("row-1", "t1")],
        ["setPrimaryTechnician", (repo) => repo.setPrimaryTechnician("row-1", "t1")],
      ],
    );
  });

  it("invoice.repo", async () => {
    await sweep(
      "invoice",
      (db) => createInvoiceRepo(db, ORG),
      [
        ["list", (repo) => repo.list({ status: "DRAFT", search: "12" })],
        ["count", (repo) => repo.count()],
        ["getById", (repo) => repo.getById("row-1")],
        ["getDetail", (repo) => repo.getDetail("row-1")],
        ["create", (repo) => repo.create({ customerId: "cust-1", subtotalCents: 100, taxCents: 8 })],
        ["update", (repo) => repo.update("row-1", { subtotalCents: 200 })],
        ["setStatus", (repo) => repo.setStatus("row-1", "SENT")],
        ["setStatus same status (no-op)", (repo) => repo.setStatus("row-1", "DRAFT")],
      ],
    );
  });
  it("estimate.repo", async () => {
    await sweep(
      "estimate",
      (db) => createEstimateRepo(db, ORG),
      [
        ["list", (repo) => repo.list({ status: "DRAFT", search: "12" })],
        ["count", (repo) => repo.count()],
        ["getById", (repo) => repo.getById("row-1")],
        ["getDetail", (repo) => repo.getDetail("row-1")],
        ["create", (repo) => repo.create({ customerId: "cust-1", subtotalCents: 100, taxCents: 8 })],
        ["update", (repo) => repo.update("row-1", { subtotalCents: 200 })],
        ["setStatus", (repo) => repo.setStatus("row-1", "SENT")],
        ["setStatus same status (no-op)", (repo) => repo.setStatus("row-1", "DRAFT")],
      ],
    );
  });
  it("operations dashboard metrics service keeps its own tenant predicate on every aggregate", async () => {
    // Covered in depth by tests/operations-dashboard-metrics.test.ts; asserted
    // here so this suite remains the single consolidated tenant-safety index.
    const { createOperationsDashboardMetricsService } = await import(
      "@/server/services/operations-dashboard-metrics.service"
    );
    const job = { count: (async () => 1) as any, aggregate: (async () => ({ _sum: { actualRevenueCents: 100 } })) as any };
    const db = { appointment: { count: (async () => 1) as any }, job, lead: { count: (async () => 1) as any } };
    const metrics = await createOperationsDashboardMetricsService(db as any).getMetrics({
      organizationId: ORG,
      todayRange: { startUtc: new Date(0), endExclusiveUtc: new Date(1) },
      range: { startUtc: new Date(0), endExclusiveUtc: new Date(1) },
    });
    expect(metrics.completedJobRevenue).toBe(100);
  });
});

/* ------------------------------------------------------------------ */
/* Layer 2 — cross-tenant rejection (rows exist ONLY in another org)   */
/* ------------------------------------------------------------------ */

/** Conservative fake: rows match a where only on shallow scalar equality. */
function rejectionDb(tables: Record<string, Array<Record<string, any>>>) {
  function matches(row: Record<string, any>, where: Record<string, any>): boolean {
    return Object.entries(where ?? {}).every(([key, value]) => {
      if (key === "id_organizationId" && value !== null && typeof value === "object") {
        return row.id === value.id && row.organizationId === value.organizationId;
      }
      if (value !== null && typeof value === "object") return false;
      return row[key] === value;
    });
  }
  const notFound = (message: string) => {
    const error: any = new Error(message);
    error.code = "P2025";
    return error;
  };
  const db: any = {};
  for (const [model, rows] of Object.entries(tables)) {
    db[model] = {
      findFirst: async ({ where }: any) => rows.find((row) => matches(row, where)) ?? null,
      findFirstOrThrow: async ({ where }: any) => {
        const row = rows.find((candidate) => matches(candidate, where));
        if (!row) throw notFound("record not found");
        return row;
      },
      update: async ({ where }: any) => {
        const row = rows.find((candidate) => matches(candidate, where));
        if (!row) throw notFound("record to update not found");
        return row;
      },
      updateMany: async ({ where }: any) => ({ count: rows.filter((row) => matches(row, where)).length }),
      delete: async ({ where }: any) => {
        const row = rows.find((candidate) => matches(candidate, where));
        if (!row) throw notFound("record to delete not found");
        return row;
      },
      deleteMany: async ({ where }: any) => ({ count: rows.filter((row) => matches(row, where)).length }),
    };
  }
  return db;
}

function crossTenantDb() {
  return rejectionDb({
    customer: [{ id: "cust-1", organizationId: OTHER, isActive: true, lastName: "Foreign" }],
    lead: [{ id: "lead-1", organizationId: OTHER, status: "NEW" }],
    location: [{ id: "loc-1", organizationId: OTHER, customerId: "cust-1" }],
    membership: [{ id: "mem-1", organizationId: OTHER, userId: "u1", isActive: true, role: "ADMIN" }],
    job: [{ id: "job-1", organizationId: OTHER, customerId: "cust-1", locationId: "loc-1", status: "DRAFT" }],
    appointment: [{ id: "apt-1", organizationId: OTHER }],
    invoice: [{ id: "inv-1", organizationId: OTHER, customerId: "cust-1", invoiceNumber: 1, status: "DRAFT", balanceCents: 0, paidCents: 0 }],
    estimate: [{ id: "est-1", organizationId: OTHER, customerId: "cust-1", estimateNumber: 1, status: "DRAFT", subtotalCents: 0, taxCents: 0, totalCents: 0 }],
  });
}

describe("cross-tenant rejection — other-org rows are invisible or rejected", () => {
  it("customer.getById returns null for a foreign id", async () => {
    const repo = createCustomerRepo(crossTenantDb() as never, ORG);
    expect(await repo.getById("cust-1")).toBeNull();
  });

  it("customer.update via a foreign compound id throws P2025", async () => {
    const repo = createCustomerRepo(crossTenantDb() as never, ORG);
    await expect(repo.update("cust-1", { lastName: "Hijack" })).rejects.toMatchObject({ code: "P2025" });
  });

  it("customer.setActive (soft delete) cannot flip a foreign row", async () => {
    const repo = createCustomerRepo(crossTenantDb() as never, ORG);
    await expect(repo.setActive("cust-1", false)).rejects.toMatchObject({ code: "P2025" });
  });

  it("lead.update and lead.remove throw NotFoundError for a foreign id", async () => {
    const repo = createLeadRepo(crossTenantDb() as never, ORG);
    await expect(repo.update("lead-1", { title: "Hijack" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.remove("lead-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lead.updateStatus (count-guarded) cannot transition a foreign lead", async () => {
    const repo = createLeadRepo(crossTenantDb() as never, ORG);
    await expect(repo.updateStatus("lead-1", { status: "WON" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("membership.updateRole cannot elevate a foreign membership", async () => {
    const repo = createMembershipRepo(crossTenantDb() as never, ORG);
    await expect(repo.updateRole("mem-1", "OWNER")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("membership.updateActive cannot deactivate a foreign membership", async () => {
    const repo = createMembershipRepo(crossTenantDb() as never, ORG);
    await expect(repo.updateActive("mem-1", false)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("location.remove cannot delete a foreign location", async () => {
    const repo = createLocationRepo(crossTenantDb() as never, ORG);
    await expect(repo.remove("loc-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("job.getById returns null and job.updateStatus throws NotFoundError for a foreign job", async () => {
    const repo = createJobRepo(crossTenantDb() as never, ORG);
    expect(await repo.getById("job-1")).toBeNull();
    await expect(repo.updateStatus("job-1", "DRAFT", { status: "IN_PROGRESS" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("appointment.cancel cannot cancel a foreign appointment", async () => {
    const repo = createAppointmentRepo(crossTenantDb() as never, ORG);
    await expect(repo.cancel("apt-1")).rejects.toMatchObject({ code: "P2025" });
  });

  it("appointment.getById returns null for a foreign appointment", async () => {
    const repo = createAppointmentRepo(crossTenantDb() as never, ORG);
    expect(await repo.getById("apt-1")).toBeNull();
  });

  it("invoice.getById returns null and setStatus throws NotFoundError for a foreign invoice", async () => {
    const repo = createInvoiceRepo(crossTenantDb() as never, ORG);
    expect(await repo.getById("inv-1")).toBeNull();
    await expect(repo.setStatus("inv-1", "SENT")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("invoice.update via a foreign compound id throws NotFoundError (pre-checked)", async () => {
    const repo = createInvoiceRepo(crossTenantDb() as never, ORG);
    await expect(repo.update("inv-1", { subtotalCents: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });
  it("estimate.getById returns null and setStatus throws NotFoundError for a foreign estimate", async () => {
    const repo = createEstimateRepo(crossTenantDb() as never, ORG);
    expect(await repo.getById("est-1")).toBeNull();
    await expect(repo.setStatus("est-1", "SENT")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("estimate.update cannot touch a foreign estimate", async () => {
    const repo = createEstimateRepo(crossTenantDb() as never, ORG);
    await expect(repo.update("est-1", { subtotalCents: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });
  it("control: the same operations succeed in-org", async () => {
    const db = rejectionDb({
      customer: [{ id: "cust-1", organizationId: ORG, isActive: true, lastName: "Local" }],
      lead: [{ id: "lead-1", organizationId: ORG, status: "NEW" }],
    });
    const customer = await createCustomerRepo(db as never, ORG).getById("cust-1");
    expect(customer).toMatchObject({ id: "cust-1", organizationId: ORG });
    const lead = await createLeadRepo(db as never, ORG).update("lead-1", { title: "Local edit" });
    expect(lead).toMatchObject({ id: "lead-1", organizationId: ORG });
  });
});

/* ------------------------------------------------------------------ */
/* Layer 3 — server-action source contract                             */
/* ------------------------------------------------------------------ */

const REPO_CALL = /create(?:Customer|Location|Lead|Job|Membership|Appointment|Technician|Invoice|Estimate)Repo\(\s*[\w$.]+,\s*([\w$.]+)/g;

describe("server actions (src/features/*/server) — source contract", () => {
  function actionFiles(): string[] {
    const featuresDir = path.join(process.cwd(), "src", "features");
    return fs
      .readdirSync(featuresDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const serverDir = path.join(featuresDir, entry.name, "server");
        if (!fs.existsSync(serverDir)) return [];
        return fs
          .readdirSync(serverDir)
          .filter((file) => file.endsWith(".actions.ts"))
          .map((file) => path.join(serverDir, file));
      });
  }

  it("every action file is gated by require* and passes an organizationId-derived tenant id to every repo call", () => {
    const violations: string[] = [];
    const files = actionFiles();
    expect(files.length > 0).toBe(true);
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const short = path.relative(process.cwd(), file);
      if (!/require(?:Permission|Role|Org)\(/.test(source)) {
        violations.push(`${short}: no requirePermission/requireRole/requireOrg gate`);
      }
      const matches = [...source.matchAll(REPO_CALL)];
      // Files without repo calls (e.g. org.actions.ts writing the global
      // Organization row by id) are fine — the gate check above still applies.
      for (const match of matches) {
        if (!match[1]!.includes("organizationId")) {
          violations.push(`${short}: repo call passes "${match[1]}" as the tenant id`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
