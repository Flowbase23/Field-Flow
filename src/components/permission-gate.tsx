import type { Permission } from "@prisma/client";

/** Server-safe permission gate. Pass effective permissions from requireOrg/permissionsFor. */
export function RequirePermission({ permission, permissions, children, fallback = null }: {
  permission: Permission; permissions: readonly Permission[]; children: React.ReactNode; fallback?: React.ReactNode;
}) { return permissions.includes(permission) ? children : fallback; }

/** Pure helper shared by server UI and tests. */
export function can(permissions: readonly Permission[], permission: Permission): boolean {
  return permissions.includes(permission);
}
