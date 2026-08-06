import Link from "next/link";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { can } from "@/components/permission-gate";
import { Button, buttonVariants } from "@/components/ui/button";
import { LEAD_SOURCES, LEAD_STATUSES } from "@/features/leads/schemas";
import { leadStatusLabel } from "@/server/domain/lead-pipeline";
import { formatMoney } from "@/lib/money";

/**
 * Leads list (Phase 1, Slice 3) — tenant-scoped with status filter, source
 * filter and search (title/description), plus pagination. Gated by LEAD_READ.
 * PENDING LIVE VERIFICATION: needs a real Clerk session.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function isIn<T extends readonly string[]>(values: T, v: string | undefined): v is T[number] {
  return v !== undefined && (values as readonly string[]).includes(v);
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; status?: string; source?: string; page?: string }>;
}) {
  const ctx = await requirePermission(Permission.LEAD_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const sp = await searchParams;

  const search = sp.search?.trim() || undefined;
  const status = isIn(LEAD_STATUSES, sp.status) ? sp.status : undefined;
  const source = isIn(LEAD_SOURCES, sp.source) ? sp.source : undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const repo = tenantDb(ctx.organizationId).leads;
  const [leads, total] = await Promise.all([
    repo.list({ search, status, source, page, pageSize: PAGE_SIZE }),
    repo.count({ search, status, source }),
  ]);

  const canCreate = can(permissions, Permission.LEAD_CREATE);
  const canUpdate = can(permissions, Permission.LEAD_UPDATE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currency = ctx.organization.currency;

  const qs = (extra: Record<string, string | undefined>) =>
    new URLSearchParams(
      Object.entries({ search, status: sp.status, source: sp.source, ...extra }).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Leads</h1>
          <p className="mt-1 text-muted-foreground">{total} lead{total === 1 ? "" : "s"} in {ctx.organization.name}.</p>
        </div>
        {canCreate && (
          <Link href={`/${ctx.organization.slug}/leads/new`} className={buttonVariants({ variant: "default", size: "default" })}>New lead</Link>
        )}
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
        <label className="min-w-52 flex-1">
          <span className="text-xs font-medium text-muted-foreground">Search</span>
          <input
            name="search"
            defaultValue={search}
            placeholder="Title or description…"
            className="mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </label>
        <label>
          <span className="text-xs font-medium text-muted-foreground">Status</span>
          <select name="status" defaultValue={sp.status ?? ""} className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <option value="">All statuses</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>{leadStatusLabel(s)}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs font-medium text-muted-foreground">Source</span>
          <select name="source" defaultValue={sp.source ?? ""} className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <option value="">All sources</option>
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase().replaceAll("_", " ")}</option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm">Filter</Button>
        {(search || sp.status || sp.source) && (
          <Link href={`/${ctx.organization.slug}/leads`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Clear</Link>
        )}
      </form>

      {leads.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="font-medium">No leads found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {search || sp.status || sp.source
              ? "Try clearing the filters, or adjust your search."
              : canCreate
                ? "Create your first lead to start the pipeline."
                : "Leads will appear here once your team adds them."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Lead</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Est. value</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {leads.map((lead) => (
                <tr key={lead.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link href={`/${ctx.organization.slug}/leads/${lead.id}`} className="font-medium text-primary hover:underline">
                      {lead.title}
                    </Link>
                    {lead.customer ? (
                      <p className="text-xs text-muted-foreground">
                        {(lead.customer.companyName ?? [lead.customer.firstName, lead.customer.lastName].filter(Boolean).join(" ")) || "customer"}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{leadStatusLabel(lead.status)}</span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{lead.source.replaceAll("_", " ")}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {lead.owner ? [lead.owner.firstName, lead.owner.lastName].filter(Boolean).join(" ") || lead.owner.email : "Unassigned"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {lead.estimatedValueCents != null ? formatMoney(lead.estimatedValueCents, currency) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      {canUpdate && (
                        <Link href={`/${ctx.organization.slug}/leads/${lead.id}/edit`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Edit</Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={`/${ctx.organization.slug}/leads?${qs({ page: String(page - 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Previous</Link>
            )}
            {page < totalPages && (
              <Link href={`/${ctx.organization.slug}/leads?${qs({ page: String(page + 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Next</Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
