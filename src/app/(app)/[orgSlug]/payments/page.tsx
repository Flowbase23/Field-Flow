import Link from "next/link";
import { Permission } from "@prisma/client";
import { buttonVariants } from "@/components/ui/button";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor, can } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { paymentMethodLabel, paymentStatusLabel } from "@/server/domain/payment-status";
import { PAYMENT_METHODS, PAYMENT_STATUSES, parsePaymentListFilters } from "@/features/payments/payment-ui";
import { formatDateInTz } from "@/lib/dates";
import { formatIntegerCents } from "@/lib/money";

const PAGE_SIZE = 25;
/** Tenant-safe payment ledger: status/method filters and pagination. */
export const dynamic = "force-dynamic";
export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePermission(Permission.PAYMENT_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const sp = await searchParams;
  const filters = parsePaymentListFilters({ status: String(sp.status ?? ""), method: String(sp.method ?? "") });
  const page = Math.max(1, Number(sp.page) || 1);
  const repo = tenantDb(ctx.organizationId).payments;
  const [payments, total] = await Promise.all([
    repo.list({ ...filters, page, pageSize: PAGE_SIZE }),
    repo.count(filters),
  ]);
  const canCreate = can(permissions, Permission.PAYMENT_CREATE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (extra: Record<string, string | undefined>) => new URLSearchParams(
    Object.entries({ status: filters.status, method: filters.method, ...extra }).filter(([, value]) => value !== undefined) as [string, string][],
  ).toString();
  return <div className="mx-auto max-w-7xl space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Payments</h1>
        <p className="mt-1 text-muted-foreground">{total} payment{total === 1 ? "" : "s"} recorded in {ctx.organization.name}. The ledger is append-only — corrections refund or void an entry, they never edit it.</p>
      </div>
      {canCreate && <Link href={`/${ctx.organization.slug}/payments/new`} className={buttonVariants({ variant: "default", size: "default" })}>Record payment</Link>}
    </div>
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      <label>
        <span className="text-xs font-medium text-muted-foreground">Status</span>
        <select name="status" defaultValue={filters.status ?? ""} className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <option value="">All statuses</option>
          {PAYMENT_STATUSES.map((status) => <option key={status} value={status}>{paymentStatusLabel(status)}</option>)}
        </select>
      </label>
      <label>
        <span className="text-xs font-medium text-muted-foreground">Method</span>
        <select name="method" defaultValue={filters.method ?? ""} className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <option value="">All methods</option>
          {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{paymentMethodLabel(method)}</option>)}
        </select>
      </label>
      <button type="submit" className={buttonVariants({ size: "sm" })}>Filter</button>
      {(filters.status || filters.method) && <Link href={`/${ctx.organization.slug}/payments`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Clear</Link>}
    </form>
    {payments.length === 0 ? <div className="rounded-lg border border-dashed p-12 text-center">
      <p className="font-medium">No payments found</p>
      <p className="mt-1 text-sm text-muted-foreground">{filters.status || filters.method ? "Try clearing the filters." : canCreate ? "Record a payment against an invoice to get started." : "Payments will appear here once your team records them."}</p>
    </div> : <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground"><tr>
          <th className="px-4 py-3">Invoice</th><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Method</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Applied</th>
        </tr></thead>
        <tbody className="divide-y">{payments.map((payment) => {
          const customerName = (payment.customer?.companyName ?? [payment.customer?.firstName, payment.customer?.lastName].filter(Boolean).join(" ")) || "Customer";
          return <tr key={payment.id} className="hover:bg-muted/40">
            <td className="px-4 py-3"><Link href={`/${ctx.organization.slug}/payments/${payment.id}`} className="font-medium text-primary hover:underline">#{payment.invoice.invoiceNumber}</Link></td>
            <td className="px-4 py-3">{customerName}</td>
            <td className="px-4 py-3 font-medium">{formatIntegerCents(payment.amountCents, ctx.organization.currency)}</td>
            <td className="px-4 py-3 text-muted-foreground">{paymentMethodLabel(payment.method)}</td>
            <td className="px-4 py-3"><PaymentStatusBadge status={payment.status} /></td>
            <td className="px-4 py-3 text-muted-foreground">{formatDateInTz(payment.appliedAt, ctx.organization.timezone, "short")}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    {totalPages > 1 && <div className="flex items-center justify-between text-sm"><p className="text-muted-foreground">Page {page} of {totalPages}</p><div className="flex gap-2">
      {page > 1 && <Link href={`/${ctx.organization.slug}/payments?${qs({ page: String(page - 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Previous</Link>}
      {page < totalPages && <Link href={`/${ctx.organization.slug}/payments?${qs({ page: String(page + 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Next</Link>}
    </div></div>}
  </div>;
}
function PaymentStatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    PENDING: "bg-blue-100 text-blue-800",
    SUCCEEDED: "bg-green-100 text-green-800",
    FAILED: "bg-muted text-muted-foreground",
    REFUNDED: "bg-amber-100 text-amber-800",
    VOIDED: "bg-muted text-muted-foreground line-through",
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[status] ?? "bg-muted"}`}>{paymentStatusLabel(status as never)}</span>;
}
