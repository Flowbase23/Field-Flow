import Link from "next/link";
import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { can } from "@/components/permission-gate";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerActiveToggle } from "@/features/customers/customer-active-toggle";
import { LocationManager } from "@/features/customers/location-manager";
import { customerDisplayName } from "@/features/customers/duplicates";
import { leadStatusLabel } from "@/server/domain/lead-pipeline";

/**
 * Customer detail page (Phase 1, Slice 3): header, locations (manage), linked
 * leads, jobs (empty state until Slice 5) and a Phase-2 timeline placeholder.
 * Permission-gated via CUSTOMER_READ; the Leads section additionally requires
 * LEAD_READ and Jobs requires JOB_READ. Cross-tenant ids → notFound() (404).
 * PENDING LIVE VERIFICATION: needs a real Clerk session.
 */
export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; customerId: string }>;
}) {
  const { customerId } = await params;
  const ctx = await requirePermission(Permission.CUSTOMER_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);

  const tenant = tenantDb(ctx.organizationId);
  const [customer, leads] = await Promise.all([
    tenant.customers.getDetail(customerId),
    can(permissions, Permission.LEAD_READ) ? tenant.leads.listByCustomer(customerId, 25) : Promise.resolve([]),
  ]);
  if (!customer) notFound();

  const canUpdate = can(permissions, Permission.CUSTOMER_UPDATE);
  const canDelete = can(permissions, Permission.CUSTOMER_DELETE);
  const canReadLeads = can(permissions, Permission.LEAD_READ);
  const canReadJobs = can(permissions, Permission.JOB_READ);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href={`/${ctx.organization.slug}/customers`} className="hover:underline">Customers</Link> / detail
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{customerDisplayName(customer)}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{customer.type.replaceAll("_", " ")}</span>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${customer.isActive ? "bg-green-100 text-green-800" : "bg-muted text-muted-foreground"}`}>
              {customer.isActive ? "Active" : "Inactive"}
            </span>
            {customer.email ? <span>{customer.email}</span> : null}
            {customer.phone ? <span>{customer.phone}</span> : null}
          </div>
          {customer.notes ? <p className="mt-3 max-w-2xl text-sm text-muted-foreground">{customer.notes}</p> : null}
        </div>
        <div className="flex gap-2">
          {canUpdate && (
            <Link href={`/${ctx.organization.slug}/customers/${customer.id}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>Edit</Link>
          )}
          <CustomerActiveToggle
            customerId={customer.id}
            isActive={customer.isActive}
            canDeactivate={canDelete}
            canActivate={canUpdate}
          />
        </div>
      </div>

      <LocationManager
        customerId={customer.id}
        orgSlug={ctx.organization.slug}
        locations={customer.locations.map((l) => ({
          id: l.id,
          label: l.label,
          address1: l.address1,
          address2: l.address2,
          city: l.city,
          state: l.state,
          postalCode: l.postalCode,
          country: l.country,
          timezone: l.timezone,
          accessNotes: l.accessNotes,
        }))}
        canManage={canUpdate}
        canDelete={canDelete}
      />

      {canReadLeads && (
        <Card>
          <CardHeader>
            <CardTitle>Leads</CardTitle>
            <CardDescription>Sales opportunities linked to this customer.</CardDescription>
          </CardHeader>
          <CardContent>
            {leads.length === 0 ? (
              <p className="text-sm text-muted-foreground">No leads linked yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {leads.map((lead) => (
                  <li key={lead.id} className="flex items-center justify-between gap-3 py-2">
                    <Link href={`/${ctx.organization.slug}/leads/${lead.id}`} className="font-medium text-primary hover:underline">
                      {lead.title}
                    </Link>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{leadStatusLabel(lead.status)}</span>
                      <span>{lead.owner ? lead.owner.firstName ?? lead.owner.email : "Unassigned"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {canReadJobs && (
        <Card>
          <CardHeader>
            <CardTitle>Jobs</CardTitle>
            <CardDescription>Work orders for this customer.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No jobs yet — {customer._count.jobs > 0 ? `${customer._count.jobs} exist but aren't listed until the Jobs slice.` : "job creation arrives in the Jobs slice (Phase 1, Slice 5)."}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>Activity history for this customer.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Timeline (calls, visits, emails, job history) arrives in Phase 2.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
