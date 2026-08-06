/**
 * Members server actions (Slice 2 follow-up) — invite, role change,
 * activate/deactivate. Every action:
 *
 *   1. starts with requirePermission(MEMBERS_MANAGE) (defense in depth —
 *      the UI also disables controls without that permission),
 *   2. validates input with a Zod schema (src/features/organizations/schemas.ts),
 *   3. reaches the Membership model ONLY through the tenant-scoped repo
 *      (createMembershipRepo injects the organizationId predicate),
 *   4. rejects self-mutation via canChangeMembership(),
 *   5. writes an append-only AuditLog entry in the same transaction (withAudit),
 *   6. returns ActionResult so the client can surface typed errors.
 *
 * Clerk-gated flow (inviteMember) is code-complete but PENDING LIVE
 * VERIFICATION: it cannot be exercised until CLERK_SECRET_KEY lands.
 */
"use server";

import { AuditAction, Permission, Role } from "@prisma/client";
import { clerkClient } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/require-org";
import { canChangeMembership } from "@/server/auth/permissions";
import { createMembershipRepo } from "@/server/repositories/membership.repo";
import { db } from "@/server/db/client";
import { withAudit, writeAuditLog } from "@/server/audit";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  actionError,
  type ActionResult,
} from "@/lib/errors";
import {
  changeRoleSchema,
  inviteMemberSchema,
  setMemberActiveSchema,
  type MembershipRole,
} from "../schemas";
import { ROLE_TO_CLERK_ROLE_KEY } from "../clerk-roles";

/**
 * Change a member's app role.
 * Guards: MEMBERS_MANAGE permission, Zod-validated role, tenant-scoped target,
 * self-role-change rejected via canChangeMembership. Audited (ROLE_CHANGED,
 * before/after snapshots).
 */
export async function changeRole(
  input: unknown,
): Promise<ActionResult<{ membershipId: string; role: Role }>> {
  try {
    const ctx = await requirePermission(Permission.MEMBERS_MANAGE);
    const { membershipId, role } = changeRoleSchema.parse(input);

    const repo = createMembershipRepo(db, ctx.organizationId);
    const target = await repo.getById(membershipId);
    if (!target) {
      throw new NotFoundError("Membership not found in this organization.");
    }
    if (!canChangeMembership(ctx.userId, target.userId, "role")) {
      throw new ForbiddenError("You cannot change your own role.");
    }
    if (target.role === role) {
      // No-op — nothing changed, nothing to audit.
      return { ok: true, data: { membershipId, role } };
    }

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.ROLE_CHANGED,
        entityType: "Membership",
        entityId: membershipId,
        before: { role: target.role, isActive: target.isActive },
        after: { role, isActive: target.isActive },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createMembershipRepo(tx, ctx.organizationId).updateRole(membershipId, role),
    );

    revalidatePath(`/${ctx.organization.slug}/settings/members`);
    return { ok: true, data: { membershipId, role: updated.role } };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Activate/deactivate a member.
 * Guards: MEMBERS_MANAGE permission, tenant-scoped target, self-deactivation
 * rejected via canChangeMembership. Audited (STATUS_CHANGED, before/after).
 */
export async function setMemberActive(
  input: unknown,
): Promise<ActionResult<{ membershipId: string; isActive: boolean }>> {
  try {
    const ctx = await requirePermission(Permission.MEMBERS_MANAGE);
    const { membershipId, isActive } = setMemberActiveSchema.parse(input);

    const repo = createMembershipRepo(db, ctx.organizationId);
    const target = await repo.getById(membershipId);
    if (!target) {
      throw new NotFoundError("Membership not found in this organization.");
    }
    if (!canChangeMembership(ctx.userId, target.userId, "status")) {
      throw new ForbiddenError("You cannot deactivate your own membership.");
    }
    if (target.isActive === isActive) {
      return { ok: true, data: { membershipId, isActive } };
    }

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.STATUS_CHANGED,
        entityType: "Membership",
        entityId: membershipId,
        before: { role: target.role, isActive: target.isActive },
        after: { role: target.role, isActive },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createMembershipRepo(tx, ctx.organizationId).updateActive(membershipId, isActive),
    );

    revalidatePath(`/${ctx.organization.slug}/settings/members`);
    return { ok: true, data: { membershipId, isActive: updated.isActive } };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Invite a user to the organization.
 *
 * Guards: MEMBERS_MANAGE permission, Zod-validated email + role, conflict
 * check against existing active memberships.
 *
 * Clerk is the invitation source; the flow is Clerk-FIRST:
 *   1. clerkClient().organizations.createOrganizationInvitation(...) with the
 *      org's CLERK organization id (from ctx — never the browser) and the
 *      Clerk role key for the requested local role.
 *   2. ONLY on success do we touch local state: if the invitee is already a
 *      known local user (e.g. a user from another org), upsert a PENDING
 *      (inactive) Membership so the Members list reflects the invite. The
 *      webhook flips isActive and syncs the role when the invitee accepts
 *      (organizationMembership.created).
 *   3. Audit INVITE_SENT with the Clerk invitation id.
 *
 * When Clerk is NOT configured we FAIL CLOSED: there is no local Invitation
 * model and memberships are only created on acceptance, so a local-only
 * "invite" could never deliver anything. This branch is PENDING LIVE
 * VERIFICATION — exercised once CLERK_SECRET_KEY lands.
 */
export async function inviteMember(
  input: unknown,
): Promise<ActionResult<{ invitationId: string; email: string; role: MembershipRole }>> {
  try {
    const ctx = await requirePermission(Permission.MEMBERS_MANAGE);
    const { email, role } = inviteMemberSchema.parse(input);

    // Conflict guard: an ACTIVE local membership for this email is already a member.
    const repo = createMembershipRepo(db, ctx.organizationId);
    const existingUser = await db.user.findFirst({ where: { email } }); // User is a global model
    if (existingUser) {
      const existing = await repo.getByUserId(existingUser.id);
      if (existing?.isActive) {
        throw new ConflictError(`${email} is already an active member of ${ctx.organization.name}.`);
      }
    }

    if (!process.env.CLERK_SECRET_KEY) {
      // PENDING LIVE VERIFICATION: requires real Clerk keys.
      throw new AppError(
        "Invitations require Clerk to be configured (CLERK_SECRET_KEY is not set).",
        { code: "CLERK_NOT_CONFIGURED", statusCode: 503 },
      );
    }

    // Clerk first — the invite is only real once Clerk accepts it.
    let clerkInvitationId: string;
    try {
      const client = await clerkClient();
      const invitation = await client.organizations.createOrganizationInvitation({
        organizationId: ctx.organization.clerkOrganizationId,
        emailAddress: email,
        role: ROLE_TO_CLERK_ROLE_KEY[role as Role],
        inviterUserId: ctx.clerkUserId,
      });
      clerkInvitationId = invitation.id;
    } catch (err) {
      throw new AppError(
        err instanceof Error ? `Clerk invitation failed: ${err.message}` : "Clerk invitation failed.",
        { code: "CLERK_API_ERROR", statusCode: 502, cause: err },
      );
    }

    // Local Membership record path — only reached when the Clerk call succeeded.
    // Best-effort: if the DB write fails after a successful Clerk invite, the
    // invite is still delivered; log and continue so we don't mask that.
    let localMembershipId: string | null = null;
    if (existingUser) {
      try {
        const membership = await repo.upsertForUser(existingUser.id, { role: role as Role, isActive: false });
        localMembershipId = membership.id;
      } catch (err) {
        console.error(
          `[members:invite] Clerk invite ${clerkInvitationId} succeeded but local membership sync failed for ${email}`,
          err,
        );
      }
    }

    await writeAuditLog({
      organizationId: ctx.organizationId,
      action: AuditAction.INVITE_SENT,
      entityType: "Membership",
      entityId: localMembershipId,
      metadata: { email, role, clerkInvitationId },
      actorUserId: ctx.userId,
      actorClerkUserId: ctx.clerkUserId,
    });

    revalidatePath(`/${ctx.organization.slug}/settings/members`);
    return { ok: true, data: { invitationId: clerkInvitationId, email, role } };
  } catch (err) {
    return actionError(err);
  }
}
