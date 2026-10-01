import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { InvoiceForm } from "@/features/invoices/invoice-form";
import { customerDisplayName } from "@/features/customers/duplicates";
export const dynamic = "force-dynamic";
export default async function EditInvoicePage({ params }: { params: Promise<{ orgSlug: string; invoiceId: string }> }) {
  const { invoiceId } = await params;
  const ctx = await requirePermission(Permission.INVOICE_UPDATE);
  const repos = tenantDb(ctx.organizationId);
  const [invoice, customers, jobs] = await Promise.all([
    repos.invoices.getDetail(invoiceId),
    repos.customers.list(),
    repos.jobs.list({ page: 1, pageSize: 100 }),
  ]);
  if (!invoice) notFound();
  return <div className="mx-auto max-w-3xl space-y-6">
    <div><h1 className="text-3xl font-bold tracking-tight">Edit invoice #{invoice.invoiceNumber}</h1><p className="mt-1 text-muted-foreground">Update customer, dates, and amounts. Status changes only through the lifecycle controls; totals are recomputed server-side.</p></div>
    <InvoiceForm mode="edit" orgSlug={ctx.organization.slug} invoiceId={invoice.id} currency={ctx.organization.currency} initial={{
      customerId: invoice.customerId,
      jobId: invoice.jobId,
      issuedAt: invoice.issuedAt?.toISOString() ?? null,
      dueAt: invoice.dueAt?.toISOString() ?? null,
      subtotalCents: invoice.subtotalCents,
      taxCents: invoice.taxCents,
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
