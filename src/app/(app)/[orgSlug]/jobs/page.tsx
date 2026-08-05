import { requirePermission } from "@/server/auth/require-org";
import { Permission } from "@prisma/client";
import { PlaceholderCard } from "@/components/layout/placeholder-card";

/**
 * Jobs — placeholder. Job creation from customer/location, type/priority/status
 * flow, technician assignment and the dispatch workflow are Phase 1 Slice 5.
 */
export const dynamic = "force-dynamic";

export default async function JobsPage() {
  await requirePermission(Permission.JOB_READ);
  return <PlaceholderCard title="Jobs" target="Slice 5 (Jobs & dispatch)" />;
}
