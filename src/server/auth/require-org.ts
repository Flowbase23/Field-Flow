/**
 * Central request-flow authorization (design §1 "Request flow").
 *
 * Every protected server action / page / route handler MUST start with one of
 * these three functions. The tenant identity is derived ONLY from the Clerk
 * session (`auth()` → orgId = Clerk organization id, userId = Clerk user id);
 * an organizationId or org slug from the browser is never trusted as the tenant
 * source (design: "Never accept organizationId from the browser").
 *
 * Flow: auth() → load local Organization by clerkOrganizationId → load local
 * User by clerkUserId → verify an ACTIVE Membership in that org → throw typed
 * errors otherwise. requirePermission/requireRole layer permission checks on top.
 *
 * Note: `userId` from Clerk is the *Clerk* user id (clerkUserId); the local
 * User.id is what appears in Membership.userId. Both are exposed on OrgContext.
 *
 * PENDING LIVE VERIFICATION: cannot be exercised without real Clerk keys —
 * the auth() shape below matches @clerk/nextjs v7 types (verified against the
 * installed package) but the full flow needs a live session to confirm.
 */
import { auth } from "@clerk/nextjs/server";
import type { Membership, Organization, Permission, Role, User } from "@prisma/client";
import { db } from "@/server/db/client";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { hasPermission } from "@/server/auth/permissions";

export interface OrgContext {
  /** Local Organization.id — the tenant id used in every tenant-scoped query. */
  organizationId: string;
  /** Local User.id — used in Membership and as AuditLog.actorUserId. */
  userId: string;
  /** Clerk user id from the session — used as AuditLog.actorClerkUserId. */
  clerkUserId: string;
  organization: Organization;
  user: User;
  membership: Membership;
}

async function loadOrgContext(): Promise<OrgContext> {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();

  if (!clerkUserId) {
    throw new UnauthorizedError("You must be signed in to access this resource.");
  }
  if (!clerkOrgId) {
    throw new UnauthorizedError("No active organization on this session.");
  }

  // Look up local records by the EXTERNAL ids — never trust slugs or local ids
  // supplied by the client. A missing org/user means the webhook sync has not
  // provisioned them (or they were deactivated); we fail closed ("treat missing
  // org as unavailable (no guessing)", design §8.5).
  const organization = await db.organization.findUnique({
    where: { clerkOrganizationId: clerkOrgId },
  });
  const user = await db.user.findUnique({ where: { clerkUserId } });

  if (!organization) {
    throw new UnauthorizedError(
      "This organization is not provisioned in FieldFlow. Contact your administrator.",
    );
  }
  if (!organization.isActive) {
    throw new UnauthorizedError("This organization is deactivated.");
  }
  if (!user) {
    throw new UnauthorizedError(
      "Your FieldFlow account is not provisioned. Contact your administrator.",
    );
  }

  const membership = await db.membership.findFirst({
    where: { organizationId: organization.id, userId: user.id, isActive: true },
  });
  if (!membership) {
    throw new ForbiddenError("You are not an active member of this organization.");
  }

  return {
    organizationId: organization.id,
    userId: user.id,
    clerkUserId,
    organization,
    user,
    membership,
  };
}

/** Authenticated + active membership in the session's org. */
export async function requireOrg(): Promise<OrgContext> {
  return loadOrgContext();
}

/** requireOrg + the caller holds `permission` (defaults or RolePermission override). */
export async function requirePermission(permission: Permission): Promise<OrgContext> {
  const ctx = await loadOrgContext();
  const allowed = await hasPermission(ctx.organizationId, ctx.membership.role, permission);
  if (!allowed) {
    throw new ForbiddenError(
      `Missing permission: ${permission}. Your role (${ctx.membership.role}) does not allow this.`,
    );
  }
  return ctx;
}

/** requireOrg + the caller's role is in `roles`. */
export async function requireRole(roles: readonly Role[]): Promise<OrgContext> {
  const ctx = await loadOrgContext();
  if (!roles.includes(ctx.membership.role)) {
    throw new ForbiddenError(
      `Your role (${ctx.membership.role}) is not allowed to perform this action.`,
    );
  }
  return ctx;
}
