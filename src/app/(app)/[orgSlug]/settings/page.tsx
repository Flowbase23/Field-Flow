import { requirePermission } from "@/server/auth/require-org";
import { Permission } from "@prisma/client";
import { PlaceholderCard } from "@/components/layout/placeholder-card";

/**
 * Settings — placeholder. Org settings (timezone/currency), membership
 * invite/deactivate and role-based visibility land in Phase 1 Slice 2.
 */
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requirePermission(Permission.ORGANIZATION_READ);
  return <PlaceholderCard title="Settings" target="Slice 2 (Tenant shell & RBAC)" />;
}
