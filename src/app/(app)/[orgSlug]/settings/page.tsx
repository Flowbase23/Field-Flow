import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { Permission } from "@prisma/client";
import { can } from "@/components/permission-gate";
import { OrgSettingsForm } from "@/features/organizations/org-settings-form";

export const dynamic = "force-dynamic";
export default async function SettingsPage() {
  const ctx = await requirePermission(Permission.ORGANIZATION_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const canManage = can(permissions, Permission.ORGANIZATION_UPDATE);
  return (
    <OrgSettingsForm
      canManage={canManage}
      org={{
        id: ctx.organization.id,
        name: ctx.organization.name,
        slug: ctx.organization.slug,
        timezone: ctx.organization.timezone,
        currency: ctx.organization.currency,
      }}
    />
  );
}
