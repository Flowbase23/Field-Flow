import { requirePermission } from "@/server/auth/require-org";
import { Permission } from "@prisma/client";
import { PlaceholderCard } from "@/components/layout/placeholder-card";

/**
 * Leads — placeholder. Lead pipeline + statuses, lead→customer association and
 * sales-rep assignment land in Phase 1 Slice 3.
 */
export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  await requirePermission(Permission.LEAD_READ);
  return <PlaceholderCard title="Leads" target="Slice 3 (CRM)" />;
}
