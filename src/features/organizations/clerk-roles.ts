/**
 * Local Role ↔ Clerk organization role key mapping (Slice 2 follow-up).
 *
 * Clerk is the identity/invitation source; the LOCAL Membership.role is
 * authoritative for app behavior (README: "Local membership is AUTHORITATIVE
 * for app roles"). This module is the single source of truth for translating
 * between the two vocabularies:
 *
 *   - inviteMember() uses ROLE_TO_CLERK_ROLE_KEY when creating invitations via
 *     clerkClient().organizations.createOrganizationInvitation(...).
 *   - the Clerk webhook uses clerkRoleKeyToLocalRole() when syncing membership
 *     events (replacing its old hard-coded two-value mapping), so an invitation
 *     created with, say, "org:technician" lands as a TECHNICIAN membership.
 *
 * PENDING LIVE VERIFICATION: Clerk ships with "org:admin" and "org:member"
 * built in; the remaining keys are CUSTOM ROLES that must be created in the
 * Clerk dashboard (Organizations → Roles) with exactly these keys before
 * invitations with those roles succeed. Until then, non-admin invites fail
 * closed with a CLERK_API_ERROR from Clerk (422 unknown role).
 */
import { Role } from "@prisma/client";

export const ROLE_TO_CLERK_ROLE_KEY: Record<Role, string> = {
  OWNER: "org:admin", // OWNER is a local-only concept; Clerk sees the owner as an admin
  ADMIN: "org:admin",
  OFFICE_STAFF: "org:member", // Clerk's built-in non-admin role — works out of the box
  DISPATCHER: "org:dispatcher", // custom role — create in the Clerk dashboard
  TECHNICIAN: "org:technician", // custom role — create in the Clerk dashboard
  SALES_REP: "org:sales_rep", // custom role — create in the Clerk dashboard
  CUSTOMER_PORTAL_USER: "org:customer_portal_user", // custom role — create in the Clerk dashboard
};

const CLERK_ROLE_KEY_TO_LOCAL_ROLE: Record<string, Role> = {
  "org:admin": Role.ADMIN,
  "org:member": Role.OFFICE_STAFF,
  "org:dispatcher": Role.DISPATCHER,
  "org:technician": Role.TECHNICIAN,
  "org:sales_rep": Role.SALES_REP,
  "org:customer_portal_user": Role.CUSTOMER_PORTAL_USER,
};

/**
 * Map a Clerk role key (from invitations/webhooks) to the local Role.
 * Unknown keys default to OFFICE_STAFF — the same fail-safe default the
 * webhook used before this module existed.
 */
export function clerkRoleKeyToLocalRole(clerkRole: string | undefined): Role {
  if (clerkRole && clerkRole in CLERK_ROLE_KEY_TO_LOCAL_ROLE) {
    return CLERK_ROLE_KEY_TO_LOCAL_ROLE[clerkRole];
  }
  return Role.OFFICE_STAFF;
}
