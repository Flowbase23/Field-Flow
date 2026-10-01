import Link from "next/link";
import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor, can } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import {
  effectiveInvoiceStatus,
  invoiceStatusLabel,
} from "@/server/domain/invoice-status";
import { can as canPermission } from "@/components/permission-gate";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoiceStatusControls } from "@/features/invoices/invoice-status-controls";
import { invoiceStatusActions } from "@/features/invoices/invoice-ui";
import { formatDateInTz } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

/** Tenant-safe invoice detail: amounts, customer/job links, lifecycle controls. */
export const dynamic = "force-dynamic";
export default async function InvoiceDetailPage({ params }: { params: Promise<{ orgSlug: string; invoiceId: string }> }) {
  const { invoiceId } = await params;
  const ctx = await requirePermission(Permission.INVOICE_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const repos = tenantDb(ctx.organizationId);
  const invoice = await repos.invoices.getDetail(invoiceId);
  if (!invoice) notFound();
  const canUpdate = canPermission(permissions, Permission.INVOICE_UPDATE);
  const canChangeStatus = canPermission(permissions, Permission.INVOICE_STATUS_UPDATE);
  // OVERDUE is derived on read — the stored status never changes to OVERDUE.
  const displayStatus = effectiveInvoiceStatus(invoice.status, invoice.dueAt, invoice.balanceCents);
  const customerName = (invoice.customer.companyName ?? [invoice.customer.firstName, invoice.customer.lastName].filter(Boolean).join(" ")) || "Customer";
  const currency = ctx.organization.currency;
  const timestamps = [
    ["Created", invoice.createdAt],
    ["Issued", invoice.issuedAt],
    ["Due", invoice.dueAt],
    ["Paid", invoice.paidAt],
    ["Last updated", invoice.updatedAt],
  ] as const;
  return <div className="mx-auto max-w-4xl space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-sm text-muted-foreground"><Link href={`/${ctx.organization.slug}/invoices`} className="hover:underline">Invoices</Link> / #{invoice.invoiceNumber}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Invoice #{invoice.invoiceNumber}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <StatusBadge status={displayStatus} />
          <span>{invoice.paidCents > 0 && invoice.balanceCents > 0 ? "Partially paid" : null}</span>
        </div>
      </div>
      {canUpdate && <Link href={`/${ctx.organization.slug}/invoices/${invoice.id}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>Edit invoice</Link>}
    </div>
    {canChangeStatus && <Card>
      <CardHeader><CardTitle>Lifecycle</CardTitle><CardDescription>Move this invoice through its allowed billing states. The server verifies every transition; OVERDUE is derived automatically from the due date and is never a button.</CardDescription></CardHeader>
      <CardContent><InvoiceStatusControls invoiceId={invoice.id} currentStatus={invoice.status} actions={invoiceStatusActions(invoice.status, { balanceCents: invoice.balanceCents, paidCents: invoice.paidCents })} /></CardContent>
    </Card>}
    <div className="grid gap-6 md:grid-cols-2">
      <Card><CardHeader><CardTitle>Customer & job</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <p><span className="text-muted-foreground">Customer</span><br /><Link href={`/${ctx.organization.slug}/customers/${invoice.customer.id}`} className="font-medium text-primary hover:underline">{customerName}</Link></p>
        {invoice.job
          ? <p><span className="text-muted-foreground">Linked job</span><br /><Link href={`/${ctx.organization.slug}/jobs/${invoice.job.id}`} className="font-medium text-primary hover:underline">#{invoice.job.jobNumber} · {invoice.job.title}</Link></p>
          : <p><span className="text-muted-foreground">Linked job</span><br /><span className="text-muted-foreground">None</span></p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Amounts</CardTitle><CardDescription>Computed server-side in integer cents. Payments are Slice P2-3 — paid amounts stay until then.</CardDescription></CardHeader>
      <CardContent><dl className="space-y-2 text-sm">
        <Amount label="Subtotal" value={invoice.subtotalCents} currency={currency} />
        <Amount label="Tax" value={invoice.taxCents} currency={currency} />
        <Amount label="Total (subtotal + tax)" value={invoice.totalCents} currency={currency} />
        <Amount label="Paid" value={invoice.paidCents} currency={currency} />
        <Amount label="Balance (total − paid)" value={invoice.balanceCents} currency={currency} strong />
      </dl></CardContent></Card>
    </div>
    {displayStatus === "OVERDUE" && <Card><CardContent className="text-sm text-destructive">This invoice is past its due date with an outstanding balance. Its stored status remains {invoiceStatusLabel(invoice.status)} — OVERDUE is derived on read.</CardContent></Card>}
    <Card><CardHeader><CardTitle>Activity timestamps</CardTitle></CardHeader><CardContent><dl className="grid gap-3 text-sm sm:grid-cols-2">{timestamps.map(([label, date]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{date ? formatDateInTz(date, ctx.organization.timezone, "medium") : "—"}</dd></div>)}</dl></CardContent></Card>
  </div>;
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
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[status] ?? "bg-muted"}`}>{invoiceStatusLabel(status as never)}</span>;
}
function Amount({ label, value, currency, strong = false }: { label: string; value: number; currency: string; strong?: boolean }) {
  return <div className="flex items-center justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className={strong ? "font-semibold" : "font-medium"}>{formatMoney(value, currency)}</dd></div>;
}
