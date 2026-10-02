import Link from "next/link";
import { Permission } from "@prisma/client";
import { buttonVariants } from "@/components/ui/button";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor, can } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { effectiveEstimateStatus, estimateStatusLabel } from "@/server/domain/estimate-status";
import { ESTIMATE_DISPLAY_STATUSES, parseEstimateListFilters } from "@/features/estimates/estimate-ui";
import { formatDateInTz } from "@/lib/dates";
import { formatIntegerCents } from "@/lib/money";

const PAGE_SIZE = 25;
/** Tenant-safe estimate list: status filter (incl. derived EXPIRED), search, pagination. */
export const dynamic = "force-dynamic";
export default async function EstimatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePermission(Permission.ESTIMATE_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const sp = await searchParams;
  const filters = parseEstimateListFilters({ status: String(sp.status ?? ""), search: String(sp.search ?? "") });
  const page = Math.max(1, Number(sp.page) || 1);
  const repo = tenantDb(ctx.organizationId).estimates;
  const [estimates, total] = await Promise.all([
    repo.list({ ...filters, page, pageSize: PAGE_SIZE }),
    repo.count(filters),
  ]);
  const canCreate = can(permissions, Permission.ESTIMATE_CREATE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (extra: Record<string, string | undefined>) => new URLSearchParams(
    Object.entries({ status: filters.status, search: filters.search, ...extra }).filter(([, value]) => value !== undefined) as [string, string][],
  ).toString();
  return <div className="mx-auto max-w-7xl space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Estimates</h1>
        <p className="mt-1 text-muted-foreground">{total} estimate{total === 1 ? "" : "s"} in {ctx.organization.name}.</p>
      </div>
      {canCreate && <Link href={`/${ctx.organization.slug}/estimates/new`} className={buttonVariants({ variant: "default", size: "default" })}>New estimate</Link>}
    </div>
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
      <label>
        <span className="text-xs font-medium text-muted-foreground">Status</span>
        <select name="status" defaultValue={filters.status ?? ""} className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <option value="">All statuses</option>
          {ESTIMATE_DISPLAY_STATUSES.map((status) => <option key={status} value={status}>{estimateStatusLabel(status)}</option>)}
        </select>
      </label>
      <label>
        <span className="text-xs font-medium text-muted-foreground">Search</span>
        <input name="search" defaultValue={filters.search ?? ""} placeholder="Estimate #, title, or customer" className="mt-1 h-9 w-56 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
      </label>
      <button type="submit" className={buttonVariants({ size: "sm" })}>Filter</button>
      {(filters.status || filters.search) && <Link href={`/${ctx.organization.slug}/estimates`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Clear</Link>}
    </form>
    {estimates.length === 0 ? <div className="rounded-lg border border-dashed p-12 text-center">
      <p className="font-medium">No estimates found</p>
      <p className="mt-1 text-sm text-muted-foreground">{filters.status || filters.search ? "Try clearing the filters or searching for a different estimate number, title, or customer." : canCreate ? "Create an estimate from a customer to get started." : "Estimates will appear here once your team creates them."}</p>
    </div> : <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground"><tr>
          <th className="px-4 py-3">Estimate</th><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Title</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Total</th><th className="px-4 py-3">Valid until</th>
        </tr></thead>
        <tbody className="divide-y">{estimates.map((estimate) => <tr key={estimate.id} className="hover:bg-muted/40">
          <td className="px-4 py-3"><Link href={`/${ctx.organization.slug}/estimates/${estimate.id}`} className="font-medium text-primary hover:underline">#{estimate.estimateNumber}</Link></td>
          <td className="px-4 py-3">{(estimate.customer.companyName ?? [estimate.customer.firstName, estimate.customer.lastName].filter(Boolean).join(" ")) || "Customer"}</td>
          <td className="px-4 py-3 max-w-48 truncate text-muted-foreground">{estimate.title ?? "—"}</td>
          <td className="px-4 py-3"><EstimateStatusBadge status={effectiveEstimateStatus(estimate.status, estimate.validUntil)} /></td>
          <td className="px-4 py-3 font-medium">{formatIntegerCents(estimate.totalCents, ctx.organization.currency)}</td>
          <td className="px-4 py-3 text-muted-foreground">{estimate.validUntil ? formatDateInTz(estimate.validUntil, ctx.organization.timezone, "short") : "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {totalPages > 1 && <div className="flex items-center justify-between text-sm"><p className="text-muted-foreground">Page {page} of {totalPages}</p><div className="flex gap-2">
      {page > 1 && <Link href={`/${ctx.organization.slug}/estimates?${qs({ page: String(page - 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Previous</Link>}
      {page < totalPages && <Link href={`/${ctx.organization.slug}/estimates?${qs({ page: String(page + 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Next</Link>}
    </div></div>}
  </div>;
}
function EstimateStatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    DRAFT: "bg-muted text-muted-foreground",
    SENT: "bg-blue-100 text-blue-800",
    ACCEPTED: "bg-green-100 text-green-800",
    DECLINED: "bg-amber-100 text-amber-800",
    VOID: "bg-muted text-muted-foreground line-through",
    EXPIRED: "bg-red-100 text-red-800",
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[status] ?? "bg-muted"}`}>{estimateStatusLabel(status)}</span>;
}
