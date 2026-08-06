import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { CustomerForm } from "@/features/customers/customer-form";

/**
 * New customer page (Phase 1, Slice 3) — gated by CUSTOMER_CREATE (the action
 * re-checks). PENDING LIVE VERIFICATION: needs a real Clerk session.
 */
export const dynamic = "force-dynamic";

export default async function NewCustomerPage() {
  const ctx = await requirePermission(Permission.CUSTOMER_CREATE);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New customer</h1>
        <p className="mt-1 text-muted-foreground">Add a customer to {ctx.organization.name}. Duplicate emails or phones are flagged so you can link instead.</p>
      </div>
      <CustomerForm mode="create" orgSlug={ctx.organization.slug} />
    </div>
  );
}
