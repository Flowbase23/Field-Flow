import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { JobForm } from "@/features/jobs/job-form";
import { customerDisplayName } from "@/features/customers/duplicates";

export const dynamic = "force-dynamic";

export default async function NewJobPage() {
  const ctx = await requirePermission(Permission.JOB_CREATE);
  const customers = await tenantDb(ctx.organizationId).customers.listWithLocations();
  return <div className="mx-auto max-w-3xl space-y-6">
    <div><h1 className="text-3xl font-bold tracking-tight">New job</h1><p className="mt-1 text-muted-foreground">Create a work order for a tenant customer and one of that customer’s service locations.</p></div>
    <JobForm mode="create" orgSlug={ctx.organization.slug} currency={ctx.organization.currency} customers={customers.map((customer) => ({
      id: customer.id,
      name: customerDisplayName(customer),
      locations: customer.locations.map((location) => ({ id: location.id, label: location.label, address: [location.address1, location.city, location.state, location.postalCode].filter(Boolean).join(", ") })),
    }))} />
  </div>;
}
