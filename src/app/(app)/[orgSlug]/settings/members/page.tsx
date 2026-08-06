import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { Permission } from "@prisma/client";
import { tenantDb } from "@/server/db/tenant-db";
import { can } from "@/components/permission-gate";
import { MembersManager } from "@/features/organizations/members-manager";

export const dynamic = "force-dynamic";
export default async function MembersPage() {
  const ctx = await requirePermission(Permission.MEMBERS_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const canManage = can(permissions, Permission.MEMBERS_MANAGE);
  const members = await tenantDb(ctx.organizationId).memberships.list();
  return (
    <MembersManager
      organizationName={ctx.organization.name}
      currentUserId={ctx.userId}
      canManage={canManage}
      members={members.map((m) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        isActive: m.isActive,
        email: m.user.email,
      }))}
    />
  );
}
