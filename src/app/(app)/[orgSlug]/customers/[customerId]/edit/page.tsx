import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { CustomerForm } from "@/features/customers/customer-form";

/**
 * Customer edit page (Phase 1, Slice 3) — gated by CUSTOMER_UPDATE (the action
 * re-checks). Cross-tenant ids are indistinguishable from missing rows
 * (tenant-scoped repo) → notFound() (404).
 * PENDING LIVE VERIFICATION: needs a real Clerk session.
 */
export const dynamic = "force-dynamic";

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ orgSlug: string; customerId: string }>;
}) {
  const { customerId } = await params;
  const ctx = await requirePermission(Permission.CUSTOMER_UPDATE);
  const customer = await tenantDb(ctx.organizationId).customers.getById(customerId);
  if (!customer) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Edit customer</h1>
        <p className="mt-1 text-muted-foreground">Update contact details, type and notes. Duplicate emails or phones are flagged.</p>
      </div>
      <CustomerForm
        mode="edit"
        orgSlug={ctx.organization.slug}
        customerId={customer.id}
        initial={{
          firstName: customer.firstName,
          lastName: customer.lastName,
          companyName: customer.companyName,
          email: customer.email,
          phone: customer.phone,
          type: customer.type,
          notes: customer.notes,
        }}
      />
    </div>
  );
}
