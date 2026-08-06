import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { LeadForm } from "@/features/leads/lead-form";

/**
 * Lead edit page (Phase 1, Slice 3) — full edit of title/source/value/owner/
 * customer/description. Gated by LEAD_UPDATE (the action re-checks). Status is
 * NOT editable here — it moves only through the pipeline (LeadStatusControls).
 * Cross-tenant ids → notFound() (404). PENDING LIVE VERIFICATION.
 */
export const dynamic = "force-dynamic";

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ orgSlug: string; leadId: string }>;
}) {
  const { leadId } = await params;
  const ctx = await requirePermission(Permission.LEAD_UPDATE);
  const tenant = tenantDb(ctx.organizationId);

  const [lead, members, customers] = await Promise.all([
    tenant.leads.getById(leadId),
    tenant.memberships.list(),
    tenant.customers.list({ isActive: true, pageSize: 100 }),
  ]);
  if (!lead) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Edit lead</h1>
        <p className="mt-1 text-muted-foreground">Update the lead details. To change its status, use the pipeline on the lead page.</p>
      </div>
      <LeadForm
        mode="edit"
        orgSlug={ctx.organization.slug}
        leadId={lead.id}
        initial={{
          title: lead.title,
          description: lead.description,
          source: lead.source,
          status: lead.status,
          estimatedValueCents: lead.estimatedValueCents,
          ownerUserId: lead.ownerUserId,
          customerId: lead.customerId,
        }}
        members={members.map((m) => ({
          id: m.userId,
          name: [m.user.firstName, m.user.lastName].filter(Boolean).join(" ") || m.user.email,
        }))}
        customers={customers.map((c) => ({
          id: c.id,
          name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.id,
        }))}
      />
    </div>
  );
}
