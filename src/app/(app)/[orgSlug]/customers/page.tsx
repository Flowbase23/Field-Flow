import { requirePermission } from "@/server/auth/require-org";
import { Permission } from "@prisma/client";
import { PlaceholderCard } from "@/components/layout/placeholder-card";

/**
 * Customers — placeholder. The CRM slice (list/search/filter, create/edit/detail,
 * locations, tenant-scoped customerRepo) is Phase 1 Slice 3.
 */
export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  await requirePermission(Permission.CUSTOMER_READ);
  return <PlaceholderCard title="Customers" target="Slice 3 (CRM)" />;
}
