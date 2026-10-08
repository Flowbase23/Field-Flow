import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/server/db/client";
import { createPortalRepo } from "@/server/repositories/portal.repo";
import { effectiveInvoiceStatus } from "@/server/domain/invoice-status";
import { paymentStatusLabel } from "@/server/domain/payment-status";
import { portalCustomerName, portalInvoicePayOffer, portalInvoiceStatusLabel } from "@/features/portal/portal-ui";
import { InvoicePortalPayButton } from "@/features/portal/invoice-portal-pay";
import { portalTokenSchema } from "@/features/portal/schemas";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateInTz } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

/**
 * PUBLIC invoice portal (Slice P2-S4): no Clerk session — the high-entropy URL
 * token IS the authorization. Read-only summary; the pay control opens a
 * Stripe-hosted checkout for the SERVER-READ balance via the same P2-3 flow
 * the internal app uses (the customer never submits an amount), and the
 * existing Stripe webhook reconciles the ledger when payment settles.
 * Invalid/malformed/unknown tokens render 404; the page is noindex.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your invoice",
  robots: { index: false, follow: false },
};

export default async function InvoicePortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ payment?: string }>;
}) {
  const { token } = await params;
  const { payment } = await searchParams;
  const parsed = portalTokenSchema.safeParse(token);
  if (!parsed.success) notFound();
  const view = await createPortalRepo(db).findInvoiceByToken(parsed.data);
  if (!view) notFound();
  const { invoice, customer, organization, payments } = view;
  // OVERDUE is derived on read (stored status never becomes OVERDUE).
  const displayStatus = effectiveInvoiceStatus(invoice.status, invoice.dueAt, invoice.balanceCents);
  const payOffer = portalInvoicePayOffer({ status: invoice.status, balanceCents: invoice.balanceCents });
  const customerName = portalCustomerName(customer);
  return <div className="w-full max-w-3xl space-y-6">
    <div>
      <p className="text-sm text-muted-foreground">{organization.name} · invoice for {customerName}</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Invoice #{invoice.invoiceNumber}</h1>
      <div className="mt-2"><StatusBadge status={displayStatus} /></div>
    </div>
    {payment === "started" && <Card><CardContent className="text-sm text-muted-foreground">Payment started — this page updates once the payment settles. A receipt follows from Stripe.</CardContent></Card>}
    {payment === "cancelled" && <Card><CardContent className="text-sm text-muted-foreground">Checkout was cancelled — nothing was charged. You can start again below.</CardContent></Card>}
    <Card>
      <CardHeader>
        <CardTitle>{payOffer === "paid" ? "Paid in full" : "Payment"}</CardTitle>
        <CardDescription>
          {payOffer === "paid"
            ? "Thank you — nothing is owed on this invoice."
            : payOffer === "blocked"
              ? "This invoice cannot be paid online right now. Please contact the company."
              : "Card payments are hosted securely by Stripe."}
        </CardDescription>
      </CardHeader>
      <CardContent>{payOffer === "payable" && <InvoicePortalPayButton token={parsed.data} />}</CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>Invoice details</CardTitle><CardDescription>Amounts are computed by the company in its own currency and cannot be edited from this page.</CardDescription></CardHeader>
      <CardContent><dl className="space-y-2 text-sm">
        <Amount label="Subtotal" value={invoice.subtotalCents} currency={organization.currency} />
        <Amount label="Tax" value={invoice.taxCents} currency={organization.currency} />
        <Amount label="Total (subtotal + tax)" value={invoice.totalCents} currency={organization.currency} />
        <Amount label="Paid" value={invoice.paidCents} currency={organization.currency} />
        <Amount label="Balance (total − paid)" value={invoice.balanceCents} currency={organization.currency} strong />
      </dl></CardContent>
    </Card>
    {payments.length > 0 && <Card>
      <CardHeader><CardTitle>Payment history</CardTitle></CardHeader>
      <CardContent><div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm">
        <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">Amount</th><th className="px-3 py-2">Method</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Applied</th></tr></thead>
        <tbody className="divide-y">{payments.map((entry) => <tr key={entry.id}>
          <td className="px-3 py-2 font-medium">{formatMoney(entry.amountCents, organization.currency)}</td>
          <td className="px-3 py-2 text-muted-foreground">{entry.method.replaceAll("_", " ").toLowerCase()}</td>
          <td className="px-3 py-2">{paymentStatusLabel(entry.status)}</td>
          <td className="px-3 py-2 text-muted-foreground">{formatDateInTz(entry.appliedAt, organization.timezone, "short")}</td>
        </tr>)}</tbody>
      </table></div></CardContent>
    </Card>}
    <Card>
      <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
      <CardContent><dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Field label="Customer" value={customerName} />
        <Field label="Due" value={invoice.dueAt ? formatDateInTz(invoice.dueAt, organization.timezone, "medium") : "—"} />
        <Field label="Issued" value={invoice.issuedAt ? formatDateInTz(invoice.issuedAt, organization.timezone, "medium") : "—"} />
        <Field label="Paid" value={invoice.paidAt ? formatDateInTz(invoice.paidAt, organization.timezone, "medium") : "—"} />
      </dl></CardContent>
    </Card>
    <p className="text-center text-xs text-muted-foreground">Questions about this invoice? Contact {organization.name} directly — this page cannot send messages.</p>
  </div>;
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>;
}
function Amount({ label, value, currency, strong = false }: { label: string; value: number; currency: string; strong?: boolean }) {
  return <div className="flex items-center justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className={strong ? "font-semibold" : "font-medium"}>{formatMoney(value, currency)}</dd></div>;
}
function StatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    DRAFT: "bg-muted text-muted-foreground",
    SENT: "bg-blue-100 text-blue-800",
    PARTIALLY_PAID: "bg-amber-100 text-amber-800",
    PAID: "bg-green-100 text-green-800",
    VOID: "bg-muted text-muted-foreground line-through",
    OVERDUE: "bg-red-100 text-red-800",
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[status] ?? "bg-muted"}`}>{status.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</span>;
}
