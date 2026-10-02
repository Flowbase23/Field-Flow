import Link from "next/link";
import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor, can } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import { paymentMethodLabel, paymentStatusLabel } from "@/server/domain/payment-status";
import { can as canPermission } from "@/components/permission-gate";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PaymentStatusControls } from "@/features/payments/payment-status-controls";
import { paymentRowActions } from "@/features/payments/payment-ui";
import { formatDateInTz } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

/** Tenant-safe payment detail: the ledger entry, its reconcile, lifecycle controls. */
export const dynamic = "force-dynamic";
export default async function PaymentDetailPage({ params }: { params: Promise<{ orgSlug: string; paymentId: string }> }) {
  const { paymentId } = await params;
  const ctx = await requirePermission(Permission.PAYMENT_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const payment = await tenantDb(ctx.organizationId).payments.getDetail(paymentId);
  if (!payment) notFound();
  const canTransition = canPermission(permissions, Permission.PAYMENT_VOID) || canPermission(permissions, Permission.PAYMENT_REFUND);
  const customerName = (payment.customer?.companyName ?? [payment.customer?.firstName, payment.customer?.lastName].filter(Boolean).join(" ")) || null;
  const currency = ctx.organization.currency;
  const timestamps = [
    ["Recorded", payment.createdAt],
    ["Applied", payment.appliedAt],
    ["Last updated", payment.updatedAt],
  ] as const;
  return <div className="mx-auto max-w-4xl space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-sm text-muted-foreground"><Link href={`/${ctx.organization.slug}/payments`} className="hover:underline">Payments</Link> / invoice #{payment.invoice.invoiceNumber}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{formatMoney(payment.amountCents, currency)} <span className="text-lg font-medium text-muted-foreground">{paymentMethodLabel(payment.method)}</span></h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <StatusBadge status={payment.status} />
        </div>
      </div>
      <Link href={`/${ctx.organization.slug}/invoices/${payment.invoiceId}`} className="text-sm text-primary hover:underline">View invoice #{payment.invoice.invoiceNumber}</Link>
    </div>
    {canTransition && <Card>
      <CardHeader><CardTitle>Ledger corrections</CardTitle><CardDescription>Refunding or voiding reverses this payment's effect on the invoice in the same transaction — the entry itself is never edited.</CardDescription></CardHeader>
      <CardContent><PaymentStatusControls paymentId={payment.id} currentStatus={payment.status} actions={paymentRowActions(payment.status)} /></CardContent>
    </Card>}
    <div className="grid gap-6 md:grid-cols-2">
      <Card><CardHeader><CardTitle>Applied to</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <p><span className="text-muted-foreground">Invoice</span><br /><Link href={`/${ctx.organization.slug}/invoices/${payment.invoiceId}`} className="font-medium text-primary hover:underline">#{payment.invoice.invoiceNumber}</Link> <span className="text-muted-foreground">· total {formatMoney(payment.invoice.totalCents, currency)} · balance {formatMoney(payment.invoice.balanceCents, currency)}</span></p>
        {customerName
          ? <p><span className="text-muted-foreground">Customer</span><br /><Link href={`/${ctx.organization.slug}/customers/${payment.customerId}`} className="font-medium text-primary hover:underline">{customerName}</Link></p>
          : <p><span className="text-muted-foreground">Customer</span><br /><span className="text-muted-foreground">Not linked</span></p>}
        <p><span className="text-muted-foreground">Notes</span><br />{payment.notes ?? <span className="text-muted-foreground">None</span>}</p>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Amounts</CardTitle><CardDescription>The ledger entry and the invoice reconcile it drove. Amounts are server-computed in integer cents.</CardDescription></CardHeader>
      <CardContent><dl className="space-y-2 text-sm">
        <Amount label="Payment amount" value={payment.amountCents} currency={currency} strong />
        <Amount label="Invoice total" value={payment.invoice.totalCents} currency={currency} />
        <Amount label="Invoice paid (after this entry)" value={payment.invoice.paidCents} currency={currency} />
        <Amount label="Invoice balance (total − paid)" value={payment.invoice.balanceCents} currency={currency} />
      </dl></CardContent></Card>
    </div>
    {payment.stripeCheckoutSessionId && <Card><CardContent className="text-sm text-muted-foreground">Opened via Stripe checkout · session {payment.stripeCheckoutSessionId}{payment.stripePaymentIntentId ? ` · intent ${payment.stripePaymentIntentId}` : ""}</CardContent></Card>}
    <Card><CardHeader><CardTitle>Activity timestamps</CardTitle></CardHeader><CardContent><dl className="grid gap-3 text-sm sm:grid-cols-2">{timestamps.map(([label, date]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{date ? formatDateInTz(date, ctx.organization.timezone, "medium") : "—"}</dd></div>)}</dl></CardContent></Card>
  </div>;
}
function StatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    PENDING: "bg-blue-100 text-blue-800",
    SUCCEEDED: "bg-green-100 text-green-800",
    FAILED: "bg-muted text-muted-foreground",
    REFUNDED: "bg-amber-100 text-amber-800",
    VOIDED: "bg-muted text-muted-foreground line-through",
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[status] ?? "bg-muted"}`}>{paymentStatusLabel(status as never)}</span>;
}
function Amount({ label, value, currency, strong = false }: { label: string; value: number; currency: string; strong?: boolean }) {
  return <div className="flex items-center justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className={strong ? "font-semibold" : "font-medium"}>{formatMoney(value, currency)}</dd></div>;
}
