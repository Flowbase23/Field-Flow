import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { InvoiceForm } from "@/features/invoices/invoice-form";
import { customerDisplayName } from "@/features/customers/duplicates";
export const dynamic = "force-dynamic";
export default async function NewInvoicePage() {
  const ctx = await requirePermission(Permission.INVOICE_CREATE);
  const repos = tenantDb(ctx.organizationId);
  const [customers, jobs] = await Promise.all([
    repos.customers.list(),
    repos.jobs.list({ page: 1, pageSize: 100 }),
  ]);
  return <div className="mx-auto max-w-3xl space-y-6">
    <div><h1 className="text-3xl font-bold tracking-tight">New invoice</h1><p className="mt-1 text-muted-foreground">Bill a tenant customer, optionally linked to a job. Totals and balances are computed server-side from the amounts you enter.</p></div>
    <InvoiceForm mode="create" orgSlug={ctx.organization.slug} currency={ctx.organization.currency} customers={customers.map((customer) => ({
      id: customer.id,
      name: customerDisplayName(customer),
    }))} jobs={jobs.map((job) => ({
      id: job.id,
      customerId: job.customerId,
      label: `#${job.jobNumber} · ${job.title}`,
    }))} />
  </div>;
}
