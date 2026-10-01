import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { EstimateForm } from "@/features/estimates/estimate-form";
import { customerDisplayName } from "@/features/customers/duplicates";
export const dynamic = "force-dynamic";
export default async function EditEstimatePage({ params }: { params: Promise<{ orgSlug: string; estimateId: string }> }) {
  const { estimateId } = await params;
  const ctx = await requirePermission(Permission.ESTIMATE_UPDATE);
  const repos = tenantDb(ctx.organizationId);
  const [estimate, customers, jobs] = await Promise.all([
    repos.estimates.getDetail(estimateId),
    repos.customers.list(),
    repos.jobs.list({ page: 1, pageSize: 100 }),
  ]);
  if (!estimate) notFound();
  return <div className="mx-auto max-w-3xl space-y-6">
    <div><h1 className="text-3xl font-bold tracking-tight">Edit estimate #{estimate.estimateNumber}</h1><p className="mt-1 text-muted-foreground">Update customer, title, validity, and amounts. Status changes only through the lifecycle controls; the total is recomputed server-side.</p></div>
    <EstimateForm mode="edit" orgSlug={ctx.organization.slug} estimateId={estimate.id} currency={ctx.organization.currency} initial={{
      customerId: estimate.customerId,
      jobId: estimate.jobId,
      title: estimate.title,
      validUntil: estimate.validUntil?.toISOString() ?? null,
      subtotalCents: estimate.subtotalCents,
      taxCents: estimate.taxCents,
    }} customers={customers.map((customer) => ({
      id: customer.id,
      name: customerDisplayName(customer),
    }))} jobs={jobs.map((job) => ({
      id: job.id,
      customerId: job.customerId,
      label: `#${job.jobNumber} · ${job.title}`,
    }))} />
  </div>;
}
