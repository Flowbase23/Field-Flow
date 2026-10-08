import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/server/db/client";
import { createPortalRepo } from "@/server/repositories/portal.repo";
import { effectiveEstimateStatus } from "@/server/domain/estimate-status";
import { portalCustomerName } from "@/features/portal/portal-ui";
import { EstimatePortalDecision } from "@/features/portal/estimate-portal-decision";
import { portalTokenSchema } from "@/features/portal/schemas";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateInTz } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

/**
 * PUBLIC estimate portal (Slice P2-S4): no Clerk session — the high-entropy
 * URL token IS the authorization. Read-only summary of the estimate; the
 * Accept/Decline controls call the token-gated server actions, which re-check
 * every guard (SENT-only, not expired) before writing through the tenant-scoped
 * repository. Invalid/malformed/unknown tokens all render 404 (no existence
 * oracle), and the page is marked noindex so search engines never see links.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your estimate",
  robots: { index: false, follow: false },
};

export default async function EstimatePortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const parsed = portalTokenSchema.safeParse(token);
  if (!parsed.success) notFound();
  const view = await createPortalRepo(db).findEstimateByToken(parsed.data);
  if (!view) notFound();
  const { estimate, customer, organization } = view;
  // EXPIRED is derived on read (stored status stays SENT).
  const displayStatus = effectiveEstimateStatus(estimate.status, estimate.validUntil);
  const customerName = portalCustomerName(customer);
  const decidable = estimate.status === "SENT" && displayStatus !== "EXPIRED";
  return <div className="w-full max-w-3xl space-y-6">
    <div>
      <p className="text-sm text-muted-foreground">{organization.name} · estimate for {customerName}</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Estimate #{estimate.estimateNumber}</h1>
      {estimate.title && <p className="mt-1 text-sm text-muted-foreground">{estimate.title}</p>}
      <div className="mt-2"><StatusBadge status={displayStatus} /></div>
    </div>
    <Card>
      <CardHeader>
        <CardTitle>Your decision</CardTitle>
        <CardDescription>
          {decidable
            ? "Review the details below and let the company know how you would like to proceed."
            : decisionNotice(displayStatus, organization.name)}
        </CardDescription>
      </CardHeader>
      <CardContent>{decidable && <EstimatePortalDecision token={parsed.data} />}</CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>Estimate details</CardTitle><CardDescription>Amounts are computed by the company in its own currency and cannot be edited from this page.</CardDescription></CardHeader>
      <CardContent><dl className="space-y-2 text-sm">
        <Amount label="Subtotal" value={estimate.subtotalCents} currency={organization.currency} />
        <Amount label="Tax" value={estimate.taxCents} currency={organization.currency} />
        <Amount label="Total (subtotal + tax)" value={estimate.totalCents} currency={organization.currency} strong />
      </dl></CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
      <CardContent><dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Field label="Customer" value={customerName} />
        <Field label="Valid until" value={estimate.validUntil ? formatDateInTz(estimate.validUntil, organization.timezone, "medium") : "No expiry set"} />
        <Field label="Sent" value={estimate.sentAt ? formatDateInTz(estimate.sentAt, organization.timezone, "medium") : "—"} />
        <Field label="Accepted" value={estimate.acceptedAt ? formatDateInTz(estimate.acceptedAt, organization.timezone, "medium") : "—"} />
      </dl></CardContent>
    </Card>
    <p className="text-center text-xs text-muted-foreground">Questions about this estimate? Contact {organization.name} directly — this page cannot send messages.</p>
  </div>;
}

function decisionNotice(status: string, orgName: string): string {
  switch (status) {
    case "ACCEPTED":
      return "You accepted this estimate. The company has been notified and will follow up.";
    case "DECLINED":
      return "You declined this estimate. The company has been notified.";
    case "VOID":
      return `${orgName} cancelled this estimate, so it can no longer be answered online.`;
    case "EXPIRED":
      return `This estimate is past its valid-until date. Please contact ${orgName} for an updated quote.`;
    default:
      return `${orgName} has not sent this estimate yet, so it cannot be answered online.`;
  }
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
    ACCEPTED: "bg-green-100 text-green-800",
    DECLINED: "bg-amber-100 text-amber-800",
    VOID: "bg-muted text-muted-foreground line-through",
    EXPIRED: "bg-red-100 text-red-800",
  };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${classes[status] ?? "bg-muted"}`}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>;
}
