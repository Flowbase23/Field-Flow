import Link from "next/link";
import { notFound } from "next/navigation";
import { Permission } from "@prisma/client";
import { requirePermission } from "@/server/auth/require-org";
import { permissionsFor } from "@/server/auth/permissions";
import { tenantDb } from "@/server/db/tenant-db";
import {
  effectiveEstimateStatus,
  estimateStatusLabel,
} from "@/server/domain/estimate-status";
import { can as canPermission } from "@/components/permission-gate";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EstimateStatusControls } from "@/features/estimates/estimate-status-controls";
import { ConvertToJobButton } from "@/features/estimates/convert-to-job-button";
import { CopyCustomerLinkButton } from "@/features/portal/copy-customer-link-button";
import { estimateStatusActions } from "@/features/estimates/estimate-ui";
import { formatDateInTz } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

/** Tenant-safe estimate detail: amounts, customer/job links, lifecycle controls. */
export const dynamic = "force-dynamic";
export default async function EstimateDetailPage({ params }: { params: Promise<{ orgSlug: string; estimateId: string }> }) {
  const { estimateId } = await params;
  const ctx = await requirePermission(Permission.ESTIMATE_READ);
  const permissions = await permissionsFor(ctx.organizationId, ctx.membership.role);
  const repos = tenantDb(ctx.organizationId);
  const estimate = await repos.estimates.getDetail(estimateId);
  if (!estimate) notFound();
  const canUpdate = canPermission(permissions, Permission.ESTIMATE_UPDATE);
  const canChangeStatus = canPermission(permissions, Permission.ESTIMATE_STATUS_UPDATE);
  const canCreateJobs = canPermission(permissions, Permission.JOB_CREATE);
  // EXPIRED is derived on read — the stored status never changes to EXPIRED.
  const displayStatus = effectiveEstimateStatus(estimate.status, estimate.validUntil);
  const customerName = (estimate.customer.companyName ?? [estimate.customer.firstName, estimate.customer.lastName].filter(Boolean).join(" ")) || "Customer";
  const currency = ctx.organization.currency;
  const timestamps = [
    ["Created", estimate.createdAt],
    ["Valid until", estimate.validUntil],
    ["Sent", estimate.sentAt],
    ["Accepted", estimate.acceptedAt],
    ["Declined", estimate.declinedAt],
    ["Last updated", estimate.updatedAt],
  ] as const;
  return <div className="mx-auto max-w-4xl space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-sm text-muted-foreground"><Link href={`/${ctx.organization.slug}/estimates`} className="hover:underline">Estimates</Link> / #{estimate.estimateNumber}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Estimate #{estimate.estimateNumber}</h1>
        {estimate.title && <p className="mt-1 text-sm text-muted-foreground">{estimate.title}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <StatusBadge status={displayStatus} />
        </div>
      </div>
      {canUpdate && <Link href={`/${ctx.organization.slug}/estimates/${estimate.id}/edit`} className={buttonVariants({ variant: "outline", size: "sm" })}>Edit estimate</Link>}
    </div>
    {canChangeStatus && <Card>
      <CardHeader><CardTitle>Lifecycle</CardTitle><CardDescription>Move this estimate through its allowed states. The server verifies every transition and stamps sent/accepted/declined itself; EXPIRED is derived automatically from the valid-until date and is never a button.</CardDescription></CardHeader>
      <CardContent><EstimateStatusControls estimateId={estimate.id} currentStatus={estimate.status} actions={estimateStatusActions(estimate.status)} /></CardContent>
    </Card>}
    {/* Conversion (P2-2 follow-up): shown only for an ACCEPTED estimate that has
        not been converted yet. `convertedJob` reads the Job.estimateId marker —
        not the user-settable "Linked job" field — so a hand-linked estimate is
        not mistaken for a conversion. The server action re-checks everything. */}
    {estimate.convertedJob ? <Card>
      <CardHeader><CardTitle>Converted to job</CardTitle><CardDescription>This estimate was turned into a work order; the conversion is recorded once and cannot be repeated.</CardDescription></CardHeader>
      <CardContent className="text-sm">
        <Link href={`/${ctx.organization.slug}/jobs/${estimate.convertedJob.id}`} className="font-medium text-primary hover:underline">View job #{estimate.convertedJob.jobNumber} · {estimate.convertedJob.title}</Link>
      </CardContent>
    </Card>
    : estimate.status === "ACCEPTED" && canCreateJobs && <Card>
      <CardHeader><CardTitle>Convert to job</CardTitle><CardDescription>Turn this accepted estimate into a draft work order. The server copies the customer and amounts, allocates the next job number, records the conversion once, and links the new job back here.</CardDescription></CardHeader>
      <CardContent><ConvertToJobButton estimateId={estimate.id} orgSlug={ctx.organization.slug} /></CardContent>
    </Card>}
    {estimate.status === "ACCEPTED" && !estimate.convertedJob && !canCreateJobs && <Card><CardContent className="text-sm text-muted-foreground">This estimate was accepted. A role with job-create permission can convert it into a work order.</CardContent></Card>}
    {/* Customer portal link (P2-S4): the office reveals (or first-generates)
        the tokenized no-login link on demand. Gated by ESTIMATE_UPDATE — the
        same permission the edit button uses; the owner can override. */}
    {canUpdate && <Card>
      <CardHeader><CardTitle>Customer link</CardTitle><CardDescription>Share a private, no-login link so the customer can view this estimate and accept or decline it online. The link authorizes by a secret token — treat it like a password; anyone who has it can see this estimate.</CardDescription></CardHeader>
      <CardContent><CopyCustomerLinkButton kind="estimate" id={estimate.id} /></CardContent>
    </Card>}
    <div className="grid gap-6 md:grid-cols-2">
      <Card><CardHeader><CardTitle>Customer & job</CardTitle></CardHeader><CardContent className="space-y-3 text-sm">
        <p><span className="text-muted-foreground">Customer</span><br /><Link href={`/${ctx.organization.slug}/customers/${estimate.customer.id}`} className="font-medium text-primary hover:underline">{customerName}</Link></p>
        {estimate.job
          ? <p><span className="text-muted-foreground">Linked job</span><br /><Link href={`/${ctx.organization.slug}/jobs/${estimate.job.id}`} className="font-medium text-primary hover:underline">#{estimate.job.jobNumber} · {estimate.job.title}</Link></p>
          : <p><span className="text-muted-foreground">Linked job</span><br /><span className="text-muted-foreground">None</span></p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Amounts</CardTitle><CardDescription>Computed server-side in integer cents.</CardDescription></CardHeader>
      <CardContent><dl className="space-y-2 text-sm">
        <Amount label="Subtotal" value={estimate.subtotalCents} currency={currency} />
        <Amount label="Tax" value={estimate.taxCents} currency={currency} />
        <Amount label="Total (subtotal + tax)" value={estimate.totalCents} currency={currency} strong />
      </dl></CardContent></Card>
    </div>
    {displayStatus === "EXPIRED" && <Card><CardContent className="text-sm text-destructive">This estimate is past its valid-until date while still awaiting a decision. Its stored status remains {estimateStatusLabel(estimate.status)} — EXPIRED is derived on read.</CardContent></Card>}
    <Card><CardHeader><CardTitle>Activity timestamps</CardTitle></CardHeader><CardContent><dl className="grid gap-3 text-sm sm:grid-cols-2">{timestamps.map(([label, date]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{date ? formatDateInTz(date, ctx.organization.timezone, "medium") : "—"}</dd></div>)}</dl></CardContent></Card>
  </div>;
}
function StatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    DRAFT: "bg-muted text-muted-foreground",
    SENT: "bg-blue-100 text-blue-800",
    ACCEPTED: "bg-green-100 text-green-800",
    DECLINED: "bg-amber-100 text-amber-800",
    VOID: "bg-muted text-muted-foreground line-through",
    EXPIRED: "bg-red-100 text-red-800",
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[status] ?? "bg-muted"}`}>{estimateStatusLabel(status)}</span>;
}
function Amount({ label, value, currency, strong = false }: { label: string; value: number; currency: string; strong?: boolean }) {
  return <div className="flex items-center justify-between gap-4"><dt className="text-muted-foreground">{label}</dt><dd className={strong ? "font-semibold" : "font-medium"}>{formatMoney(value, currency)}</dd></div>;
}
