/**
 * Authorization gate tests for requireOrg / requirePermission / requireRole
 * (src/server/auth/require-org.ts) — the seam that turns a Clerk session into
 * a tenant context and enforces the permission check before every protected
 * page/action.
 *
 * IN-MEMORY ONLY: Clerk's auth() and the shared Prisma db singleton are
 * replaced with bun:test `mock.module()` fakes, so no live Clerk keys or
 * database are needed. They run under `bun test` (the project gate). The file
 * is excluded from vitest (vitest cannot resolve bun:test) — see
 * vitest.config.ts.
 *
 * NOT covered here (PENDING LIVE VERIFICATION — needs real Clerk keys and a
 * provisioned org, see docs/runbook.md §7): the real @clerk/nextjs auth()
 * session shape, middleware route protection, and webhook-driven provisioning.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

/** The fake Clerk session that the mocked auth() resolves to; tests mutate it. */
const clerkSession: { userId?: string; orgId?: string } = {
  userId: "clerk-user-1",
  orgId: "clerk-org-1",
};
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => clerkSession,
}));

/** In-memory Organization/User/Membership/RolePermission tables backing db. */
const state = {
  organizations: [] as Array<Record<string, any>>,
  users: [] as Array<Record<string, any>>,
  memberships: [] as Array<Record<string, any>>,
  rolePermissions: [] as Array<{ organizationId: string; role: string; permission: string }>,
};
mock.module("@/server/db/client", () => ({
  db: {
    organization: {
      findUnique: async ({ where }: any) =>
        state.organizations.find((row) => row.clerkOrganizationId === where.clerkOrganizationId) ?? null,
    },
    user: {
      findUnique: async ({ where }: any) =>
        state.users.find((row) => row.clerkUserId === where.clerkUserId) ?? null,
    },
    membership: {
      findFirst: async ({ where }: any) =>
        state.memberships.find(
          (row) =>
            row.organizationId === where.organizationId &&
            row.userId === where.userId &&
            row.isActive === where.isActive,
        ) ?? null,
    },
    rolePermission: {
      findMany: async ({ where }: any) =>
        state.rolePermissions
          .filter((row) => row.organizationId === where.organizationId && row.role === where.role)
          .map((row) => ({ permission: row.permission })),
    },
  },
}));

// Import the module under test AFTER the mocks are registered.
const { requireOrg, requirePermission, requireRole } = await import("@/server/auth/require-org");
const { ForbiddenError, UnauthorizedError } = await import("@/lib/errors");

const ORG_ID = "org-local-1";
const USER_ID = "user-local-1";

beforeEach(() => {
  clerkSession.userId = "clerk-user-1";
  clerkSession.orgId = "clerk-org-1";
  state.organizations = [
    { id: ORG_ID, clerkOrganizationId: "clerk-org-1", isActive: true, slug: "acme", name: "Acme", timezone: "UTC", currency: "USD" },
  ];
  state.users = [{ id: USER_ID, clerkUserId: "clerk-user-1", email: "tech@acme.test" }];
  state.memberships = [
    { id: "m1", organizationId: ORG_ID, userId: USER_ID, role: "TECHNICIAN", isActive: true },
  ];
  state.rolePermissions = [];
});

describe("requireOrg — Clerk session → tenant context", () => {
  it("rejects without a Clerk session", async () => {
    delete clerkSession.userId;
    await expect(requireOrg()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a session without an active organization", async () => {
    delete clerkSession.orgId;
    await expect(requireOrg()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("fails closed when the org is not provisioned locally (never guesses)", async () => {
    state.organizations = [];
    await expect(requireOrg()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("fails closed when the org is deactivated", async () => {
    state.organizations[0]!.isActive = false;
    await expect(requireOrg()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("fails closed when the user is not provisioned locally", async () => {
    state.users = [];
    await expect(requireOrg()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects without an ACTIVE membership (inactive member → Forbidden)", async () => {
    state.memberships = [
      { id: "m1", organizationId: ORG_ID, userId: USER_ID, role: "TECHNICIAN", isActive: false },
    ];
    await expect(requireOrg()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("returns LOCAL ids (never Clerk ids) as the tenant/actor context", async () => {
    const ctx = await requireOrg();
    expect(ctx.organizationId).toBe(ORG_ID);
    expect(ctx.userId).toBe(USER_ID);
    expect(ctx.clerkUserId).toBe("clerk-user-1");
    expect(ctx.membership.role).toBe("TECHNICIAN");
  });

  it("cannot see a membership in a DIFFERENT org (cross-tenant membership is invisible)", async () => {
    state.memberships = [
      { id: "m-other", organizationId: "org-other", userId: USER_ID, role: "OWNER", isActive: true },
    ];
    await expect(requireOrg()).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("requirePermission — role defaults + RolePermission overrides", () => {
  it("passes when the role's default permissions include the permission", async () => {
    // TECHNICIAN defaults include JOB_READ.
    const ctx = await requirePermission("JOB_READ");
    expect(ctx.organizationId).toBe(ORG_ID);
  });

  it("rejects with ForbiddenError naming the missing permission and role", async () => {
    await expect(requirePermission("MEMBERS_MANAGE")).rejects.toThrow(
      /Missing permission: MEMBERS_MANAGE.*TECHNICIAN/,
    );
  });

  it("honors a per-org RolePermission override", async () => {
    state.rolePermissions = [
      { organizationId: ORG_ID, role: "TECHNICIAN", permission: "MEMBERS_MANAGE" },
    ];
    const ctx = await requirePermission("MEMBERS_MANAGE");
    expect(ctx.membership.role).toBe("TECHNICIAN");
  });

  it("an override REPLACES the defaults (does not merge)", async () => {
    state.rolePermissions = [
      { organizationId: ORG_ID, role: "TECHNICIAN", permission: "MEMBERS_MANAGE" },
    ];
    await expect(requirePermission("JOB_READ")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("another org's override does not leak into this org", async () => {
    state.rolePermissions = [
      { organizationId: "org-other", role: "TECHNICIAN", permission: "MEMBERS_MANAGE" },
    ];
    await expect(requirePermission("MEMBERS_MANAGE")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("requireRole — explicit role lists", () => {
  it("passes for an allowed role", async () => {
    const ctx = await requireRole(["TECHNICIAN", "DISPATCHER"]);
    expect(ctx.userId).toBe(USER_ID);
  });

  it("rejects with ForbiddenError for a role outside the list", async () => {
    await expect(requireRole(["OWNER"])).rejects.toBeInstanceOf(ForbiddenError);
  });
});
