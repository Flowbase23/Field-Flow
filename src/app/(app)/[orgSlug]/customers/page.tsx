import Link from "next/link";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { can } from "@/components/permission-gate";
import { Button, buttonVariants } from "@/components/ui/button";
import { CUSTOMER_TYPES } from "@/features/customers/schemas";
import { CustomerActiveToggle } from "@/features/customers/customer-active-toggle";
import { customerDisplayName } from "@/features/customers/duplicates";

/**
 * Customers list (Phase 1, Slice 3) — tenant-scoped list with search
 * (name/company/email/phone), type filter, active/inactive status filter,
 * pagination and row actions. Permission-gated via CUSTOMER_READ (defense in
 * depth: the shell nav is filtered too, and the create/edit/deactivate
 * controls are gated by their own permissions).
 *
 * PENDING LIVE VERIFICATION: requires a real Clerk session + provisioned org.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function isCustomerType(value: string): value is (typeof CUSTOMER_TYPES)[number] {
  return (CUSTOMER_TYPES as readonly string[]).includes(value);
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; type?: string; status?: string; page?: string }>;
}) {
  const ctx = await requirePermission(Permission.CUSTOMER_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const sp = await searchParams;

  const search = sp.search?.trim() || undefined;
  const type = sp.type && isCustomerType(sp.type) ? sp.type : undefined;
  const isActive = sp.status === "inactive" ? false : sp.status === "active" ? true : undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  const repo = tenantDb(ctx.organizationId).customers;
  const [customers, total] = await Promise.all([
    repo.list({ search, type, isActive, page, pageSize: PAGE_SIZE, withCounts: true }),
    repo.count({ search, type, isActive }),
  ]);

  const canCreate = can(permissions, Permission.CUSTOMER_CREATE);
  const canUpdate = can(permissions, Permission.CUSTOMER_UPDATE);
  const canDelete = can(permissions, Permission.CUSTOMER_DELETE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const qs = (extra: Record<string, string | undefined>) =>
    new URLSearchParams(
      Object.entries({ search, type, status: sp.status, ...extra }).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Customers</h1>
          <p className="mt-1 text-muted-foreground">{total} customer{total === 1 ? "" : "s"} in {ctx.organization.name}.</p>
        </div>
        {canCreate && (
          <Link href={`/${ctx.organization.slug}/customers/new`} className={buttonVariants({ variant: "default", size: "default" })}>New customer</Link>
        )}
      </div>

      {/* Search + filters — GET form keeps this server-rendered (no client JS needed). */}
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
        <label className="min-w-56 flex-1">
          <span className="text-xs font-medium text-muted-foreground">Search</span>
          <input
            name="search"
            defaultValue={search}
            placeholder="Name, company, email or phone…"
            className="mt-1 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </label>
        <label>
          <span className="text-xs font-medium text-muted-foreground">Type</span>
          <select name="type" defaultValue={type ?? ""} className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <option value="">All types</option>
            {CUSTOMER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0) + t.slice(1).toLowerCase().replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-xs font-medium text-muted-foreground">Status</span>
          <select name="status" defaultValue={sp.status ?? ""} className="mt-1 h-9 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        <Button type="submit" size="sm">Filter</Button>
        {(search || type || sp.status) && (
          <Link href={`/${ctx.organization.slug}/customers`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Clear</Link>
        )}
      </form>

      {customers.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="font-medium">No customers found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {search || type || sp.status
              ? "Try clearing the filters, or adjust your search."
              : canCreate
                ? "Create your first customer to get started."
                : "Customers will appear here once your team adds them."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Jobs</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {customers.map((c) => (
                <tr key={c.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <Link href={`/${ctx.organization.slug}/customers/${c.id}`} className="font-medium text-primary hover:underline">
                      {customerDisplayName(c)}
                    </Link>
                    {c.companyName && (c.firstName || c.lastName) ? (
                      <p className="text-xs text-muted-foreground">{c.companyName}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.email ? <p>{c.email}</p> : null}
                    {c.phone ? <p>{c.phone}</p> : null}
                    {!c.email && !c.phone ? <span className="text-xs">—</span> : null}
                  </td>
                  <td className="px-4 py-3">{c.type.replaceAll("_", " ")}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${c.isActive ? "bg-green-100 text-green-800" : "bg-muted text-muted-foreground"}`}>
                      {c.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{"_count" in c ? String((c as typeof c & { _count: { jobs: number } })._count.jobs) : "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {canUpdate && (
                        <Link href={`/${ctx.organization.slug}/customers/${c.id}/edit`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Edit</Link>
                      )}
                      <CustomerActiveToggle
                        customerId={c.id}
                        isActive={c.isActive}
                        canDeactivate={canDelete}
                        canActivate={canUpdate}
                      />
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
              <Link href={`/${ctx.organization.slug}/customers?${qs({ page: String(page - 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Previous</Link>
            )}
            {page < totalPages && (
              <Link href={`/${ctx.organization.slug}/customers?${qs({ page: String(page + 1) })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Next</Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
