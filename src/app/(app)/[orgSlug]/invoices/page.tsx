import Link from "next/link";
import { Permission } from "@prisma/client";
import { buttonVariants } from "@/components/ui/button";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor, can } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { effectiveInvoiceStatus, invoiceStatusLabel } from "@/server/domain/invoice-status";
import { INVOICE_STATUSES, parseInvoiceListFilters } from "@/features/invoices/invoice-ui";
import { formatDateInTz } from "@/lib/dates";
import { formatIntegerCents } from "@/lib/money";

const PAGE_SIZE = 25;
/** Tenant-safe invoice list: status filter, search, and pagination. */
export const dynamic = "force-dynamic";
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePermission(Permission.INVOICE_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const sp = await searchParams;
  const filters = parseInvoiceListFilters({ status: String(sp.status ?? ""), search: String(sp.search ?? "") });
  const page = Math.max(1, Number(sp.page) || 1);
  const repo = tenantDb(ctx.organizationId).invoices;
  const [invoices, total] = await Promise.all([
    repo.list({ ...filters, page, pageSize: PAGE_SIZE }),
    repo.count(filters),
  ]);
  const canCreate = can(permissions, Permission.INVOICE_CREATE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (extra: Record<string, string | undefined>) => new URLSearchParams(
    Object.entries({ status: filters.status, search: filters.search, ...extra }).filter(([, value]) => value !== undefined) as [string, string][],
  ).toString();
  return <div className="mx-auto max-w-7xl space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Invoices</h1>
        <p className="mt-1 text-muted-foreground">{total} invoice{total === 1 ? "" : "s"} in {ctx.organization.name}.</p>
      </div>
      {canCreate && <Link href={`/${ctx.organization.slug}/invoices/new`} className={buttonVariants({ variant: "default", size: "default" })}>New invoice</Link>}
    </div>
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      <label>
        <span className="text-xs font-medium text-muted-foreground">Status</span>
        <select name="status" defaultValue={filters.status ?? ""} className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <option value="">All statuses</option>
          {INVOICE_STATUSES.map((status) => <option key={status} value={status}>{invoiceStatusLabel(status)}</option>)}
        </select>
      </label>
      <label>
        <span className="text-xs font-medium text-muted-foreground">Search</span>
        <input name="search" defaultValue={filters.search ?? ""} placeholder="Invoice # or customer" className="mt-1 h-9 w-56 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
      </label>
      <button type="submit" className={buttonVariants({ size: "sm" })}>Filter</button>
      {(filters.status || filters.search) && <Link href={`/${ctx.organization.slug}/invoices`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Clear</Link>}
    </form>
    {invoices.length === 0 ? <div className="rounded-lg border border-dashed p-12 text-center">
      <p className="font-medium">No invoices found</p>
      <p className="mt-1 text-sm text-muted-foreground">{filters.status || filters.search ? "Try clearing the filters or searching for a different invoice number or customer." : canCreate ? "Create an invoice from a customer to get started." : "Invoices will appear here once your team creates them."}</p>
    </div> : <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground"><tr>
          <th className="px-4 py-3">Invoice</th><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Total</th><th className="px-4 py-3">Balance</th><th className="px-4 py-3">Due</th>
        </tr></thead>
        <tbody className="divide-y">{invoices.map((invoice) => <tr key={invoice.id} className="hover:bg-muted/40">
          <td className="px-4 py-3"><Link href={`/${ctx.organization.slug}/invoices/${invoice.id}`} className="font-medium text-primary hover:underline">#{invoice.invoiceNumber}</Link></td>
          <td className="px-4 py-3">{(invoice.customer.companyName ?? [invoice.customer.firstName, invoice.customer.lastName].filter(Boolean).join(" ")) || "Customer"}</td>
          <td className="px-4 py-3"><InvoiceStatusBadge status={effectiveInvoiceStatus(invoice.status, invoice.dueAt, invoice.balanceCents)} /></td>
          <td className="px-4 py-3 font-medium">{formatIntegerCents(invoice.totalCents, ctx.organization.currency)}</td>
          <td className="px-4 py-3">{formatIntegerCents(invoice.balanceCents, ctx.organization.currency)}</td>
          <td className="px-4 py-3 text-muted-foreground">{invoice.dueAt ? formatDateInTz(invoice.dueAt, ctx.organization.timezone, "short") : "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {totalPages > 1 && <div className="flex items-center justify-between text-sm"><p className="text-muted-foreground">Page {page} of {totalPages}</p><div className="flex gap-2">
      {page > 1 && <Link href={`/${ctx.organization.slug}/invoices?${qs({ page: String(page - 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Previous</Link>}
      {page < totalPages && <Link href={`/${ctx.organization.slug}/invoices?${qs({ page: String(page + 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Next</Link>}
    </div></div>}
  </div>;
}
function InvoiceStatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    DRAFT: "bg-muted text-muted-foreground",
    SENT: "bg-blue-100 text-blue-800",
    PARTIALLY_PAID: "bg-amber-100 text-amber-800",
    PAID: "bg-green-100 text-green-800",
    VOID: "bg-muted text-muted-foreground line-through",
    OVERDUE: "bg-red-100 text-red-800",
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[status] ?? "bg-muted"}`}>{invoiceStatusLabel(status as never)}</span>;
}
