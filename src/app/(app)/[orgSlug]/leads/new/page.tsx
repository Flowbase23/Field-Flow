import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { LeadForm } from "@/features/leads/lead-form";

/**
 * New lead page (Phase 1, Slice 3) — gated by LEAD_CREATE (the action
 * re-checks). Owner options = org members (sales rep assignment); customer
 * options = active customers (optional link). PENDING LIVE VERIFICATION.
 */
export const dynamic = "force-dynamic";

export default async function NewLeadPage() {
  const ctx = await requirePermission(Permission.LEAD_CREATE);
  const tenant = tenantDb(ctx.organizationId);
  const [members, customers] = await Promise.all([
    tenant.memberships.list(),
    tenant.customers.list({ isActive: true, pageSize: 100 }),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New lead</h1>
        <p className="mt-1 text-muted-foreground">Log an opportunity and assign it to a sales rep. Status changes later go through the pipeline.</p>
      </div>
      <LeadForm
        mode="create"
        orgSlug={ctx.organization.slug}
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
