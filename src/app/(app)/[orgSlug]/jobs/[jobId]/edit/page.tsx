import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { JobForm } from "@/features/jobs/job-form";
import { customerDisplayName } from "@/features/customers/duplicates";

export const dynamic = "force-dynamic";

export default async function EditJobPage({ params }: { params: Promise<{ orgSlug: string; jobId: string }> }) {
  const { jobId } = await params;
  const ctx = await requirePermission(Permission.JOB_UPDATE);
  const tenant = tenantDb(ctx.organizationId);
  const [job, customers] = await Promise.all([tenant.jobs.getDetail(jobId), tenant.customers.listWithLocations()]);
  if (!job) notFound();
  return <div className="mx-auto max-w-3xl space-y-6">
    <div><h1 className="text-3xl font-bold tracking-tight">Edit job</h1><p className="mt-1 text-muted-foreground">Update work-order details and amounts. Status changes only through the lifecycle controls.</p></div>
    <JobForm mode="edit" orgSlug={ctx.organization.slug} currency={ctx.organization.currency} jobId={job.id} initial={{
      customerId: job.customerId, locationId: job.locationId, title: job.title, type: job.type, priority: job.priority, description: job.description,
      quotedAmountCents: job.quotedAmountCents, subtotalCents: job.subtotalCents, taxCents: job.taxCents, totalCents: job.totalCents, actualRevenueCents: job.actualRevenueCents,
    }} customers={customers.map((customer) => ({
      id: customer.id, name: customerDisplayName(customer),
      locations: customer.locations.map((location) => ({ id: location.id, label: location.label, address: [location.address1, location.city, location.state, location.postalCode].filter(Boolean).join(", ") })),
    }))} />
  </div>;
}
