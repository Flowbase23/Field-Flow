/**
 * Server-side permission model.
 *
 * The Permission/Role enums live in the Prisma schema. This module maps
 * Role → default Permission[] and supports per-organization overrides via the
 * RolePermission table: when an organization has rows for (organizationId, role),
 * those rows REPLACE the built-in defaults for that role (override semantics,
 * documented in README). Authorization decisions always go through
 * `permissionsFor`/`hasPermission` — never hard-code role checks in features.
 *
 * These defaults are the initial hypothesis and will be refined with product;
 * they are deliberately conservative for lower-privilege roles.
 */
import type { Permission, Role } from "@prisma/client";
import { db } from "@/server/db/client";

/** Every permission value from the schema, in schema order. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  "ORGANIZATION_READ",
  "ORGANIZATION_UPDATE",
  "MEMBERS_READ",
  "MEMBERS_MANAGE",
  "CUSTOMER_READ",
  "CUSTOMER_CREATE",
  "CUSTOMER_UPDATE",
  "CUSTOMER_DELETE",
  "LEAD_READ",
  "LEAD_CREATE",
  "LEAD_UPDATE",
  "LEAD_DELETE",
  "JOB_READ",
  "JOB_CREATE",
  "JOB_UPDATE",
  "JOB_DELETE",
  "JOB_ASSIGN",
  "JOB_STATUS_UPDATE",
  "SCHEDULE_READ",
  "SCHEDULE_CREATE",
  "SCHEDULE_UPDATE",
  "SCHEDULE_DELETE",
  "DASHBOARD_READ",
  "AUDIT_READ",
];

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Owners and admins: full platform access within the org.
  OWNER: ALL_PERMISSIONS,
  ADMIN: ALL_PERMISSIONS,

  // Dispatcher: owns scheduling and assignment, can read/update jobs.
  DISPATCHER: [
    "DASHBOARD_READ",
    "JOB_READ",
    "JOB_UPDATE",
    "JOB_ASSIGN",
    "JOB_STATUS_UPDATE",
    "SCHEDULE_READ",
    "SCHEDULE_CREATE",
    "SCHEDULE_UPDATE",
    "SCHEDULE_DELETE",
  ],

  // Technician: sees their own jobs/schedule and reports status.
  // (Data scoping to "own records" is enforced in the repositories, Slice 4/5.)
  TECHNICIAN: ["JOB_READ", "JOB_STATUS_UPDATE", "SCHEDULE_READ"],

  // Office staff: CRM read/write, jobs read/write, scheduling read.
  // Invoicing permissions do not exist yet (Phase 2); they will be granted here.
  OFFICE_STAFF: [
    "DASHBOARD_READ",
    "CUSTOMER_READ",
    "CUSTOMER_CREATE",
    "CUSTOMER_UPDATE",
    "CUSTOMER_DELETE",
    "LEAD_READ",
    "LEAD_CREATE",
    "LEAD_UPDATE",
    "LEAD_DELETE",
    "JOB_READ",
    "JOB_CREATE",
    "JOB_UPDATE",
    "SCHEDULE_READ",
  ],

  // Sales reps: work leads, read customers.
  SALES_REP: ["CUSTOMER_READ", "LEAD_READ", "LEAD_CREATE", "LEAD_UPDATE"],

  // Portal users: minimal read access, further scoped to their own records later.
  CUSTOMER_PORTAL_USER: ["CUSTOMER_READ", "JOB_READ", "SCHEDULE_READ"],
};

/**
 * Effective permission set for (organizationId, role).
 * RolePermission rows for the pair replace the defaults entirely.
 */
export async function permissionsFor(
  organizationId: string,
  role: Role,
): Promise<readonly Permission[]> {
  const overrides = await db.rolePermission.findMany({
    where: { organizationId, role },
    select: { permission: true },
  });
  if (overrides.length > 0) {
    return overrides.map((row) => row.permission);
  }
  return DEFAULT_ROLE_PERMISSIONS[role];
}

export async function hasPermission(
  organizationId: string,
  role: Role,
  permission: Permission,
): Promise<boolean> {
  return (await permissionsFor(organizationId, role)).includes(permission);
}

export function hasRole(role: Role, allowedRoles: readonly Role[]): boolean {
  return allowedRoles.includes(role);
}

/** Hard safety rule: a member may never change their own role or active status. */
export function canChangeMembership(actorUserId: string, targetUserId: string, operation: "role" | "status"): boolean {
  void operation;
  return actorUserId !== targetUserId;
}

/** Client-safe equivalent for already-loaded effective permissions. */
export function can(permissions: readonly Permission[], permission: Permission): boolean {
  return permissions.includes(permission);
}
