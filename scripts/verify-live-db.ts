/**
 * Live-database verification — runtime persistence + cross-tenant isolation
 * against the real provisioned Postgres (Neon). Phase 1 gate evidence.
 *
 * NOT part of the `bun test` suite (the suite runs in-memory, without a
 * database — do not wire this into package.json or vitest/bun test).
 *
 * Run manually with DATABASE_URL exported:
 *
 *   bun scripts/verify-live-db.ts
 *
 * What it does:
 *   0. Sweeps leftovers of any previous crashed run (all verification rows are
 *      labelled: Organization.slug / User.clerkUserId start with `zzverify-`).
 *   1. Creates two clearly-labelled organizations (A and B), one user + one
 *      active OWNER membership each, and — through the tenant-scoped
 *      repositories (`tenantDb(organizationId)`), never raw SQL on tenant
 *      models — one customer + service location + job under org A.
 *   2. Asserts the writes round-trip (persistence).
 *   3. Asserts org B can neither see nor mutate org A's rows — reads return
 *      null/empty and writes fail closed (NotFoundError from the repo guard or
 *      Prisma P2025 from the compound `id_organizationId` backstop), and that
 *      the rejected writes left org A's rows untouched.
 *   4. In a `finally` block, deletes every created row in FK-safe order
 *      (job → location → customer → membership → user → organization, the
 *      organization delete cascading any residue) and verifies ZERO residual
 *      marker rows remain — the database is left clean regardless of whether
 *      assertions pass or fail.
 *
 * Tenant-model note: creation and all product-level reads/writes go through
 * `tenantDb(organizationId)` / the repositories, matching application code.
 * The cleanup/sweep and the "is it gone" counts are maintenance operations in
 * this script only (a tenant repo cannot delete across tenants by design);
 * they use the typed Prisma client, never $queryRaw.
 *
 * Exits 0 when every assertion passes, 1 otherwise.
 */

import { Prisma } from "@prisma/client";
import { db } from "@/server/db/client";
import { tenantDb } from "@/server/db/tenant-db";
import { NotFoundError } from "@/lib/errors";

/** Namespace marker for every row this script ever creates (visible + cleanable). */
const MARKER_PREFIX = "zzverify-";
const marker = `zzverify-${Date.now()}`;

// ─── Result recording ────────────────────────────────────────────────────────

type Row = { name: string; ok: boolean; detail: string };
const results: Row[] = [];

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(1, 60 - title.length))}`);
}

function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function expectTruthy(
  name: string,
  condition: boolean,
  detail = "",
): Promise<void> {
  record(name, condition, condition ? detail : `assertion failed ${detail}`);
}

async function expectNull(
  name: string,
  value: unknown,
  describe: string,
): Promise<void> {
  if (value === null) record(name, true, describe);
  else record(name, false, `expected null, got ${safeJson(value)}`);
}

async function expectEmpty(
  name: string,
  value: unknown[],
): Promise<void> {
  record(name, value.length === 0, value.length === 0 ? "empty as required" : `got ${value.length} row(s): ${safeJson(value)}`);
}

/** Expects `run()` to reject with a fail-closed error (NotFoundError or P2025). */
async function expectRejected(
  name: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
    record(name, false, "call SUCCEEDED — cross-tenant access was not rejected");
  } catch (err) {
    if (err instanceof NotFoundError) {
      record(name, true, "rejected with NotFoundError (repo tenant guard)");
    } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      record(name, true, "rejected with Prisma P2025 (compound id_organizationId miss)");
    } else {
      record(name, false, `unexpected error type: ${errText(err)}`);
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 140) ?? String(v);
  } catch {
    return String(v);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// ─── Cleanup (FK-safe order) + residual verification ─────────────────────────

/** Deletes everything belonging to one of THIS SCRIPT's marker organizations. */
async function cleanupOrg(orgId: string): Promise<void> {
  // FK order: Job → Customer/Location (restrict), Location → Customer (cascade).
  await db.job.deleteMany({ where: { organizationId: orgId } });
  await db.location.deleteMany({ where: { organizationId: orgId } });
  await db.customer.deleteMany({ where: { organizationId: orgId } });
  await db.membership.deleteMany({ where: { organizationId: orgId } });
  await db.organization.delete({ where: { id: orgId } }); // cascade backstop
}

/** Removes rows from a previous crashed run, so re-runs are idempotent. */
async function sweepLeftovers(): Promise<number> {
  const staleOrgs = await db.organization.findMany({
    where: { slug: { startsWith: MARKER_PREFIX } },
    select: { id: true },
  });
  for (const org of staleOrgs) await cleanupOrg(org.id);
  const staleUsers = await db.user.findMany({
    where: { clerkUserId: { startsWith: MARKER_PREFIX } },
    select: { id: true },
  });
  if (staleUsers.length > 0) {
    await db.user.deleteMany({ where: { id: { in: staleUsers.map((u) => u.id) } } });
  }
  return staleOrgs.length + staleUsers.length;
}

/** Asserts ZERO marker rows remain anywhere. Returns all-zero? */
async function verifyResidual(orgIds: string[], clerkUserIds: string[]): Promise<boolean> {
  const [orgs, users, customers, jobs, locations, memberships] = await Promise.all([
    db.organization.count({ where: { slug: { startsWith: MARKER_PREFIX } } }),
    db.user.count({ where: { clerkUserId: { startsWith: MARKER_PREFIX } } }),
    db.customer.count({ where: { organizationId: { in: orgIds } } }),
    db.job.count({ where: { organizationId: { in: orgIds } } }),
    db.location.count({ where: { organizationId: { in: orgIds } } }),
    db.membership.count({ where: { organizationId: { in: orgIds } } }),
  ]);
  const rows: Array<[string, number]> = [
    ["organizations (marker slugs)", orgs],
    ["users (marker clerk ids)", users],
    ["customers (marker orgs)", customers],
    ["jobs (marker orgs)", jobs],
    ["locations (marker orgs)", locations],
    ["memberships (marker orgs)", memberships],
  ];
  let allZero = true;
  for (const [label, count] of rows) {
    record(`cleanup: residual ${label} = ${count}`, count === 0, count === 0 ? "zero residual" : "RESIDUAL ROWS REMAIN");
    if (count !== 0) allZero = false;
  }
  return allZero;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be exported (the provisioned Neon instance).");
  }
  console.log(`Live-DB verification — marker ${marker}`);
  console.log(`Target: ${new URL(process.env.DATABASE_URL).host}`);

  const swept = await sweepLeftovers();
  console.log(`Swept ${swept} leftover marker row-group(s) from previous runs (0 expected on first run).`);

  // Rows this run creates — cleanup touches only these (plus their children via cascade).
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const clerkUserIds: string[] = [];

  try {
    // ── Provision the two tenants ──────────────────────────────────────────
    section("Provision: organizations, users, memberships");
    const orgA = await db.organization.create({
      data: {
        clerkOrganizationId: `${marker}_clerk_org_a`,
        slug: `${marker}-org-a`,
        name: `Verify Org A (${marker})`,
        timezone: "America/New_York",
      },
    });
    const orgB = await db.organization.create({
      data: {
        clerkOrganizationId: `${marker}_clerk_org_b`,
        slug: `${marker}-org-b`,
        name: `Verify Org B (${marker})`,
        timezone: "America/New_York",
      },
    });
    orgIds.push(orgA.id, orgB.id);

    const userA = await db.user.create({
      data: {
        clerkUserId: `${marker}-clerk-user-a`,
        email: `${marker}.user-a@example.invalid`,
        firstName: "Verify",
        lastName: "User A",
      },
    });
    const userB = await db.user.create({
      data: {
        clerkUserId: `${marker}-clerk-user-b`,
        email: `${marker}.user-b@example.invalid`,
        firstName: "Verify",
        lastName: "User B",
      },
    });
    userIds.push(userA.id, userB.id);
    clerkUserIds.push(userA.clerkUserId, userB.clerkUserId);

    // Memberships through the tenant-scoped repo, as the invite flow does.
    const membershipA = await tenantDb(orgA.id).memberships.upsertForUser(userA.id, {
      role: "OWNER",
      isActive: true,
    });
    const membershipB = await tenantDb(orgB.id).memberships.upsertForUser(userB.id, {
      role: "OWNER",
      isActive: true,
    });
    console.log(
      `  created: 2 orgs, 2 users, 2 memberships\n` +
        `    org A ${orgA.id} (slug ${orgA.slug})\n` +
        `    org B ${orgB.id} (slug ${orgB.slug})`,
    );

    // ── Org A data through tenantDb(orgA) ──────────────────────────────────
    section("Create org A customer + location + job via tenantDb(orgA)");
    const tenantA = tenantDb(orgA.id);
    const tenantB = tenantDb(orgB.id);

    const customerA = await tenantA.customers.create({
      firstName: "Verify",
      lastName: `TenantA ${marker}`,
      email: `${marker}.customer-a@example.invalid`,
      phone: "+15550000001",
      type: "RESIDENTIAL",
      notes: `Live-DB verification row ${marker} — safe to delete.`,
    });
    const locationA = await tenantA.locations.create({
      customerId: customerA.id,
      label: `${marker}-primary`,
      address1: "1 Verification Way",
      city: "Verify City",
      state: "VS",
      postalCode: "00000",
    });
    const jobA = await tenantA.jobs.create({
      customerId: customerA.id,
      locationId: locationA.id,
      type: "SERVICE_CALL",
      title: `${marker} job`,
      description: "Live-DB verification job",
      quotedAmountCents: 12345,
    });
    console.log(
      `  created: customer ${customerA.id}, location ${locationA.id}, job ${jobA.id} (jobNumber ${jobA.jobNumber})`,
    );

    // ── Persistence assertions (org A scope) ───────────────────────────────
    section("Persistence: writes round-trip through the live database");

    const custRead = await tenantA.customers.getById(customerA.id);
    await expectTruthy(
      "customer round-trips (id/org/name/email/type/active)",
      !!custRead &&
        custRead.id === customerA.id &&
        custRead.organizationId === orgA.id &&
        custRead.firstName === "Verify" &&
        custRead.lastName === `TenantA ${marker}` &&
        custRead.email === `${marker}.customer-a@example.invalid` &&
        custRead.type === "RESIDENTIAL" &&
        custRead.isActive === true,
      custRead ? "all fields match" : "customer read back as null",
    );

    const locRead = await tenantA.locations.getById(locationA.id);
    await expectTruthy(
      "location round-trips (id/org/customer/address)",
      !!locRead &&
        locRead.id === locationA.id &&
        locRead.organizationId === orgA.id &&
        locRead.customerId === customerA.id &&
        locRead.address1 === "1 Verification Way" &&
        locRead.city === "Verify City" &&
        locRead.postalCode === "00000",
      locRead ? "all fields match" : "location read back as null",
    );

    const jobRead = await tenantA.jobs.getById(jobA.id);
    await expectTruthy(
      "job round-trips (org/org-assigned jobNumber=1/type/status/refs)",
      !!jobRead &&
        jobRead.id === jobA.id &&
        jobRead.organizationId === orgA.id &&
        jobRead.jobNumber === 1 &&
        jobRead.type === "SERVICE_CALL" &&
        jobRead.status === "DRAFT" &&
        jobRead.customerId === customerA.id &&
        jobRead.locationId === locationA.id &&
        jobRead.quotedAmountCents === 12345,
      jobRead ? `jobNumber=${jobRead.jobNumber} status=${jobRead.status}` : "job read back as null",
    );

    const jobDetail = await tenantA.jobs.getDetail(jobA.id);
    await expectTruthy(
      "job detail joins the right customer + location",
      !!jobDetail && jobDetail.customer.id === customerA.id && jobDetail.location.id === locationA.id,
      jobDetail ? "nested customer/location ids match" : "job detail read back as null",
    );

    const memRead = await tenantA.memberships.getByUserId(userA.id);
    await expectTruthy(
      "membership round-trips (OWNER + active, org-scoped)",
      !!memRead &&
        memRead.id === membershipA.id &&
        memRead.organizationId === orgA.id &&
        memRead.role === "OWNER" &&
        memRead.isActive === true,
      memRead ? `role=${memRead.role} active=${memRead.isActive}` : "membership read back as null",
    );

    const updated = await tenantA.customers.update(customerA.id, { phone: "+15550000002" });
    await expectTruthy(
      "update persists (phone change reads back)",
      updated.phone === "+15550000002" && (await tenantA.customers.getById(customerA.id))?.phone === "+15550000002",
      "phone +15550000002 round-tripped",
    );

    const aCustList = await tenantA.customers.list({ search: marker });
    const aJobList = await tenantA.jobs.list();
    await expectTruthy(
      "org A sees exactly its own 1 customer / 1 job",
      aCustList.length === 1 && aJobList.length === 1 && aJobList[0]?.id === jobA.id,
      `customers=${aCustList.length} jobs=${aJobList.length}`,
    );

    // ── Cross-tenant isolation: org B reads must see nothing ───────────────
    section("Isolation: org B reads of org A rows return null / empty");

    await expectNull("B customers.getById(A customer) → null", await tenantB.customers.getById(customerA.id), "tenant predicate hid the row");
    await expectNull("B customers.getDetail(A customer) → null", await tenantB.customers.getDetail(customerA.id), "incl. locations join — hidden");
    await expectEmpty("B customers.list(search=marker) → []", await tenantB.customers.list({ search: marker }));
    await expectTruthy("B customers.count(search=marker) → 0", (await tenantB.customers.count({ search: marker })) === 0, "count 0");
    await expectNull("B locations.getById(A location) → null", await tenantB.locations.getById(locationA.id), "hidden");
    await expectEmpty("B locations.listByCustomer(A customer) → []", await tenantB.locations.listByCustomer(customerA.id));
    await expectNull("B jobs.getById(A job) → null", await tenantB.jobs.getById(jobA.id), "hidden");
    await expectNull("B jobs.getDetail(A job) → null", await tenantB.jobs.getDetail(jobA.id), "hidden");
    await expectEmpty("B jobs.list() → []", await tenantB.jobs.list());
    await expectTruthy("B jobs.count(customerId=A customer) → 0", (await tenantB.jobs.count({ customerId: customerA.id })) === 0, "count 0");
    await expectNull("B memberships.getById(A membership) → null", await tenantB.memberships.getById(membershipA.id), "hidden");
    await expectNull("B memberships.getByUserId(A user) → null", await tenantB.memberships.getByUserId(userA.id), "hidden");

    // ── Cross-tenant isolation: org B writes must fail closed ──────────────
    section("Isolation: org B writes against org A rows fail closed");

    await expectRejected("B jobs.create(customer=A's, location=A's) rejected", () =>
      tenantB.jobs.create({
        customerId: customerA.id,
        locationId: locationA.id,
        type: "SERVICE_CALL",
        title: "cross-tenant attempt",
      }),
    );
    await expectRejected("B customers.setActive(A customer, false) rejected", () =>
      tenantB.customers.setActive(customerA.id, false),
    );
    await expectRejected("B customers.update(A customer, firstName=HIJACKED) rejected", () =>
      tenantB.customers.update(customerA.id, { firstName: "HIJACKED" }),
    );
    await expectRejected("B jobs.updateStatus(A job → CANCELLED) rejected", () =>
      tenantB.jobs.updateStatus(jobA.id, "DRAFT", { status: "CANCELLED" }),
    );
    await expectRejected("B memberships.updateRole(A membership → ADMIN) rejected", () =>
      tenantB.memberships.updateRole(membershipA.id, "ADMIN"),
    );

    const untouched = await tenantA.customers.getById(customerA.id);
    await expectTruthy(
      "org A rows unchanged after org B's rejected writes",
      !!untouched &&
        untouched.isActive === true &&
        untouched.firstName === "Verify" &&
        untouched.phone === "+15550000002",
      untouched ? "isActive/firstName/phone intact" : "row missing",
    );

    // ── Cleanup ────────────────────────────────────────────────────────────
    section("Cleanup: delete created rows in FK-safe order");
    await db.job.deleteMany({ where: { id: jobA.id, organizationId: orgA.id } });
    await db.location.deleteMany({ where: { id: locationA.id, organizationId: orgA.id } });
    await db.customer.deleteMany({ where: { id: customerA.id, organizationId: orgA.id } });
    const memDeleted = await db.membership.deleteMany({
      where: { organizationId: { in: orgIds } },
    });
    const usersDeleted = await db.user.deleteMany({ where: { id: { in: userIds } } });
    const orgsDeleted = await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    console.log(
      `  deleted: 1 job, 1 location, 1 customer, ${memDeleted.count} memberships, ${usersDeleted.count} users, ${orgsDeleted.count} organizations (+ FK cascade residue)`,
    );
  } finally {
    // Crash-safe backstop: if anything above threw mid-creation, remove the
    // orgs (their deletes cascade to children) and their users anyway.
    try {
      for (const orgId of orgIds) {
        const stillThere = await db.organization.findUnique({ where: { id: orgId }, select: { id: true } });
        if (stillThere) await cleanupOrg(orgId);
      }
      if (userIds.length > 0) {
        await db.user.deleteMany({ where: { id: { in: userIds } } });
      }
    } catch (cleanupErr) {
      console.error("CLEANUP ERROR (verification rows may remain):", errText(cleanupErr));
      console.error(`Marker for manual cleanup: ${marker}`);
    }

    section("Residual verification (must all be zero)");
    const clean = await verifyResidual(orgIds, clerkUserIds);
    console.log(
      `\n${clean ? "DATABASE LEFT CLEAN" : "DATABASE HAS RESIDUAL VERIFICATION ROWS"} — marker ${marker}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n══ Summary: ${results.length - failed.length}/${results.length} assertions passed ══`);
  if (failed.length > 0) {
    console.log("Failed assertions:");
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log("LIVE-DB VERIFICATION PASSED: persistence + cross-tenant isolation proven, DB left clean.");
  }
}

main()
  .catch((err) => {
    console.error("\nVerification run failed before completion:", errText(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
