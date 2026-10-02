import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { tenantDb } from "@/server/db/tenant-db";
import { PaymentForm } from "@/features/payments/payment-form";
import { canInvoiceReceivePayment } from "@/server/domain/invoice-payment-status";
import { customerDisplayName } from "@/features/customers/duplicates";
export const dynamic = "force-dynamic";
/** Record a manual payment against an invoice that can still receive money. */
export default async function NewPaymentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePermission(Permission.PAYMENT_CREATE);
  const sp = await searchParams;
  const requestedInvoiceId = typeof sp.invoice === "string" ? sp.invoice : undefined;
  const repos = tenantDb(ctx.organizationId);
  // Payable = the repo's own rule: SENT/PARTIALLY_PAID/PAID by status, then a
  // positive balance (a PAID invoice with balance > 0 cannot exist here, but
  // the filter keeps the picker honest regardless).
  const invoices = await repos.invoices.list({ page: 1, pageSize: 100 });
  const payable = invoices
    .filter((invoice) => canInvoiceReceivePayment(invoice.status) && invoice.balanceCents > 0)
    .map((invoice) => ({
      id: invoice.id,
      label: `#${invoice.invoiceNumber} · ${customerDisplayName(invoice.customer)} · balance ${invoice.balanceCents / 100}`,
      balanceCents: invoice.balanceCents,
    }));
  return <div className="mx-auto max-w-3xl space-y-6">
    <div><h1 className="text-3xl font-bold tracking-tight">Record payment</h1><p className="mt-1 text-muted-foreground">Apply money to an outstanding invoice. The server recomputes paid and balance; overpayment and draft/void invoices are rejected.</p></div>
    {payable.length === 0
      ? <div className="rounded-lg border border-dashed p-12 text-center"><p className="font-medium">No invoices can receive a payment</p><p className="mt-1 text-sm text-muted-foreground">Send an invoice first — draft and void invoices cannot receive payments.</p></div>
      : <PaymentForm orgSlug={ctx.organization.slug} currency={ctx.organization.currency} invoices={payable} defaultInvoiceId={payable.some((invoice) => invoice.id === requestedInvoiceId) ? requestedInvoiceId : undefined} />}
  </div>;
}
