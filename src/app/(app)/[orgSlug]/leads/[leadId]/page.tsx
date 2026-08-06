import Link from "next/link";
import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { can } from "@/components/permission-gate";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LeadStatusControls } from "@/features/leads/lead-status-controls";
import { LeadCustomerActions } from "@/features/leads/lead-customer-actions";
import { LEAD_TRANSITIONS, leadStatusLabel } from "@/server/domain/lead-pipeline";
import { formatMoney } from "@/lib/money";
import { formatDateInTz } from "@/lib/dates";

/**
 * Lead detail page (Phase 1, Slice 3): header + description, pipeline status
 * controls (server-enforced transitions), lead↔customer association (attach
 * existing / convert WON) and full edit. Gated by LEAD_READ; mutations gated
 * by LEAD_UPDATE. Cross-tenant ids → notFound() (404).
 * PENDING LIVE VERIFICATION: needs a real Clerk session.
 */
export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; leadId: string }>;
}) {
  const { leadId } = await params;
  const ctx = await requirePermission(Permission.LEAD_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const tenant = tenantDb(ctx.organizationId);

  const [lead, customers] = await Promise.all([
    tenant.leads.getById(leadId),
    can(permissions, Permission.LEAD_UPDATE) ? tenant.customers.list({ isActive: true, pageSize: 100 }) : Promise.resolve([]),
  ]);
  if (!lead) notFound();

  const canUpdate = can(permissions, Permission.LEAD_UPDATE);
  const allowedNext = canUpdate ? LEAD_TRANSITIONS[lead.status] : [];
  const currency = ctx.organization.currency;
  const tz = ctx.organization.timezone;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            <Link href={`/${ctx.organization.slug}/leads`} className="hover:underline">Leads</Link> / detail
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{lead.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{leadStatusLabel(lead.status)}</span>
            <span>{lead.source.replaceAll("_", " ")}</span>
            {lead.estimatedValueCents != null ? <span>{formatMoney(lead.estimatedValueCents, currency)}</span> : null}
            <span>Opened {formatDateInTz(lead.createdAt, tz, "short")}</span>
            {lead.owner ? (
              <span>Owner: {[lead.owner.firstName, lead.owner.lastName].filter(Boolean).join(" ") || lead.owner.email}</span>
            ) : (
              <span>Unassigned</span>
            )}
          </div>
        </div>
        {canUpdate && (
          <Link href={`/${ctx.organization.slug}/leads/${lead.id}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>Edit lead</Link>
        )}
      </div>

      {lead.description ? (
        <Card>
          <CardHeader>
            <CardTitle>Description</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">{lead.description}</CardContent>
        </Card>
      ) : null}

      {canUpdate && (
        <Card>
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
            <CardDescription>
              Move the lead forward: New → Contacted → Qualified → Estimate → Won. Any stage can be lost (with a reason). Won and lost are final.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LeadStatusControls leadId={lead.id} currentStatus={lead.status} allowedNext={[...allowedNext]} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Customer</CardTitle>
          <CardDescription>
            {lead.customer
              ? "This lead is linked to a customer."
              : "Link this lead to an existing customer, or convert a won lead into a new customer record."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {lead.customer ? (
            <p className="text-sm">
              <Link
                href={`/${ctx.organization.slug}/customers/${lead.customer.id}`}
                className="font-medium text-primary hover:underline"
              >
                {(lead.customer.companyName ?? [lead.customer.firstName, lead.customer.lastName].filter(Boolean).join(" ")) || "customer"}
              </Link>
            </p>
          ) : canUpdate ? (
            <LeadCustomerActions
              leadId={lead.id}
              status={lead.status}
              hasCustomer={false}
              customers={customers.map((c) => ({
                id: c.id,
                name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.id,
              }))}
              orgSlug={ctx.organization.slug}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Not linked to a customer.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
