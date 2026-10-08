/**
 * Customer portal server actions — Phase 2 Slice P2-S4.
 *
 * ACCESS MODEL (documented for the owner; override by swapping the permission
 * constants below or by adding a rate-limit/audit layer):
 *
 * - The portal has NO customer accounts and NO Clerk login. The two public
 *   routes (/portal/estimate/[token], /portal/invoice/[token]) are added to the
 *   Clerk middleware's public matcher, and authorization is purely
 *   possession of the high-entropy `portalToken` stored on the row (256-bit,
 *   globally unique → the token resolves exactly one tenant's row).
 * - The PUBLIC accept/decline/pay actions never call requirePermission(): the
 *   customer is the actor. Audit rows are still written for every transition
 *   with actorUserId/actorClerkUserId = null and metadata
 *   { via: "customer_portal", actorType: "customer" }.
 * - The INTERNAL "copy customer link" actions are permission-gated office-staff
 *   actions (ESTIMATE_UPDATE / INVOICE_UPDATE — documented default, same policy
 *   as the other update actions; the owner can override via RolePermission).
 *
 * Money stays server-authoritative: the customer never submits an amount — the
 * checkout charges the server-read Invoice.balanceCents through the SAME
 * createPending + createInvoiceCheckoutSession + webhook-reconcile flow as the
 * internal Stripe button (P2-3).
 */
"use server";
import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { actionError, ConflictError, NotFoundError, type ActionResult } from "@/lib/errors";
import { toAuditJson, writeAuditLog } from "@/server/audit";
import { requestOrigin } from "@/server/http-origin";
import { requirePermission } from "@/server/auth/require-org";
import { db } from "@/server/db/client";
import { createEstimateRepo } from "@/server/repositories/estimate.repo";
import { createInvoiceRepo } from "@/server/repositories/invoice.repo";
import { createPaymentRepo } from "@/server/repositories/payment.repo";
import { createPortalRepo, type PortalEstimateView } from "@/server/repositories/portal.repo";
import { effectiveEstimateStatus } from "@/server/domain/estimate-status";
import { portalTokenFingerprint } from "@/server/domain/portal-token";
import { createInvoiceCheckoutSession } from "@/server/stripe/adapter";
import {
  portalLinkRevealSchema,
  portalTokenActionSchema,
} from "../schemas";

export interface EstimatePortalDecisionResult {
  estimateNumber: number;
  status: string;
  totalCents: number;
}
export interface PortalLinkResult {
  /** Absolute URL for the customer (e.g. https://app/portal/estimate/<token>). */
  url: string;
  /** Whether this call generated a NEW token (false = link already existed). */
  generated: boolean;
}
export interface InvoicePortalCheckoutResult {
  /** Stripe-hosted URL the browser is redirected to. */
  url: string;
  paymentId: string;
}

/**
 * Permission gating for the internal link actions (documented default — the
 * owner can override these without a migration, same as every permission).
 */
const LINK_ESTIMATE_PERMISSION = Permission.ESTIMATE_UPDATE;
const LINK_INVOICE_PERMISSION = Permission.INVOICE_UPDATE;

function portalAuditMetadata(extra: Record<string, unknown> = {}) {
  return { via: "customer_portal", actorType: "customer", ...extra };
}

/** The internal estimate detail page should refetch after a token generation. */
function revalidateEstimateDetail(orgSlug: string, estimateId: string): void {
  revalidatePath(`/${orgSlug}/estimates/${estimateId}`);
}
function revalidateInvoiceDetail(orgSlug: string, invoiceId: string): void {
  revalidatePath(`/${orgSlug}/invoices/${invoiceId}`);
}

/**
 * INTERNAL (office staff): resolve or first-generate the estimate's customer
 * link and return the absolute URL to copy. Permission-gated; audited only
 * when a token is first generated (a re-reveal is a read, not a change).
 */
export async function revealEstimatePortalLink(input: unknown): Promise<ActionResult<PortalLinkResult>> {
  try {
    const ctx = await requirePermission(LINK_ESTIMATE_PERMISSION);
    const { id } = portalLinkRevealSchema.parse(input);
    const { estimate, generated } = await db.$transaction(async (tx) => {
      const result = await createEstimateRepo(tx, ctx.organizationId).ensurePortalToken(id);
      if (result.generated) {
        await writeAuditLog(
          {
            organizationId: ctx.organizationId,
            action: AuditAction.UPDATE,
            entityType: "Estimate",
            entityId: id,
            after: toAuditJson({ portalTokenFingerprint: portalTokenFingerprint(result.estimate.portalToken ?? "") }),
            metadata: toAuditJson({ portalLink: "generated", via: "internal_ui" }),
            actorUserId: ctx.userId,
            actorClerkUserId: ctx.clerkUserId,
          },
          tx,
        );
      }
      return result;
    });
    revalidateEstimateDetail(ctx.organization.slug, estimate.id);
    // Absolute URL when the request origin is known (the copy-paste target);
    // relative fallback keeps the action usable in non-HTTP contexts.
    const origin = await requestOrigin();
    const path = `/portal/estimate/${estimate.portalToken}`;
    return { ok: true, data: { url: origin ? `${origin}${path}` : path, generated } };
  } catch (err) {
    return actionError(err);
  }
}

/** INTERNAL (office staff): the invoice's customer link (see the estimate twin). */
export async function revealInvoicePortalLink(input: unknown): Promise<ActionResult<PortalLinkResult>> {
  try {
    const ctx = await requirePermission(LINK_INVOICE_PERMISSION);
    const { id } = portalLinkRevealSchema.parse(input);
    const { invoice, generated } = await db.$transaction(async (tx) => {
      const result = await createInvoiceRepo(tx, ctx.organizationId).ensurePortalToken(id);
      if (result.generated) {
        await writeAuditLog(
          {
            organizationId: ctx.organizationId,
            action: AuditAction.UPDATE,
            entityType: "Invoice",
            entityId: id,
            after: toAuditJson({ portalTokenFingerprint: portalTokenFingerprint(result.invoice.portalToken ?? "") }),
            metadata: toAuditJson({ portalLink: "generated", via: "internal_ui" }),
            actorUserId: ctx.userId,
            actorClerkUserId: ctx.clerkUserId,
          },
          tx,
        );
      }
      return result;
    });
    revalidateInvoiceDetail(ctx.organization.slug, invoice.id);
    // Absolute URL when the request origin is known (the copy-paste target);
    // relative fallback keeps the action usable in non-HTTP contexts.
    const origin = await requestOrigin();
    const path = `/portal/invoice/${invoice.portalToken}`;
    return { ok: true, data: { url: origin ? `${origin}${path}` : path, generated } };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Snapshot shared by the accept/decline audit rows (mirrors the internal
 * setEstimateStatus snapshots so the audit trail reads uniformly).
 */
function estimateSnapshot(estimate: {
  estimateNumber: number;
  customerId: string;
  status: string;
  validUntil: Date | null;
  sentAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}) {
  return {
    estimateNumber: estimate.estimateNumber,
    customerId: estimate.customerId,
    status: estimate.status,
    validUntil: estimate.validUntil?.toISOString() ?? null,
    sentAt: estimate.sentAt?.toISOString() ?? null,
    acceptedAt: estimate.acceptedAt?.toISOString() ?? null,
    declinedAt: estimate.declinedAt?.toISOString() ?? null,
    subtotalCents: estimate.subtotalCents,
    taxCents: estimate.taxCents,
    totalCents: estimate.totalCents,
  };
}

/**
 * PUBLIC (customer via token): accept a SENT, non-expired estimate.
 *
 * Guard order: token resolves → estimate must be SENT (DRAFT/VOID and terminal
 * ACCEPTED/DECLINED are rejected) → not past validUntil (EXPIRED is derived).
 * The write reuses the estimate repository's setStatus (transition map +
 * optimistic guard) inside one transaction with the audit row.
 */
export async function acceptEstimateByPortalToken(input: unknown): Promise<ActionResult<EstimatePortalDecisionResult>> {
  return decideEstimateByPortalToken(input, "ACCEPTED");
}

/** PUBLIC (customer via token): decline a SENT, non-expired estimate. */
export async function declineEstimateByPortalToken(input: unknown): Promise<ActionResult<EstimatePortalDecisionResult>> {
  return decideEstimateByPortalToken(input, "DECLINED");
}

async function decideEstimateByPortalToken(
  input: unknown,
  decision: "ACCEPTED" | "DECLINED",
): Promise<ActionResult<EstimatePortalDecisionResult>> {
  try {
    const { token } = portalTokenActionSchema.parse(input);
    const now = new Date();
    const result = await db.$transaction(async (tx) => {
      const view = await createPortalRepo(tx).findEstimateByToken(token);
      if (!view) throw new NotFoundError("This customer link is not valid.");
      assertEstimateDecidable(view, now);
      // The token resolved the tenant; every write below is scoped to that org.
      const estimateRepo = createEstimateRepo(tx, view.estimate.organizationId);
      const before = await estimateRepo.getById(view.estimate.id);
      const updated = await estimateRepo.setStatus(view.estimate.id, decision, { now });
      await writeAuditLog(
        {
          organizationId: view.estimate.organizationId,
          action: AuditAction.STATUS_CHANGED,
          entityType: "Estimate",
          entityId: view.estimate.id,
          before: toAuditJson(before ? estimateSnapshot(before) : null),
          after: toAuditJson(estimateSnapshot(updated)),
          metadata: toAuditJson(portalAuditMetadata()),
          // The actor is the (anonymous) customer — there is no user to attach.
          actorUserId: null,
          actorClerkUserId: null,
        },
        tx,
      );
      return updated;
    });
    return {
      ok: true,
      data: { estimateNumber: result.estimateNumber, status: result.status, totalCents: result.totalCents },
    };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Guard shared by accept/decline: only a SENT estimate that has not passed its
 * validUntil may be decided from the portal. DRAFT/VOID/terminal states and
 * derived-EXPIRED all throw with a customer-appropriate message.
 */
function assertEstimateDecidable(view: PortalEstimateView, now: Date): void {
  const { status, validUntil } = view.estimate;
  if (status !== "SENT") {
    throw new ConflictError(
      status === "DRAFT"
        ? "This estimate has not been sent by the company yet, so it cannot be answered online."
        : status === "VOID"
          ? "This estimate was cancelled by the company and can no longer be answered online."
          : "A decision for this estimate has already been recorded online.",
    );
  }
  if (effectiveEstimateStatus(status, validUntil, now) === "EXPIRED") {
    throw new ConflictError("This estimate is past its valid-until date. Please contact the company for an updated quote.");
  }
}

/**
 * PUBLIC (customer via token): open a Stripe hosted checkout for the invoice's
 * outstanding balance. Reuses the P2-3 payment flow end to end:
 * getPayableInvoice (not DRAFT/VOID, balance > 0) → createPending (PENDING
 * ledger row) → createInvoiceCheckoutSession charging the SERVER-READ balance
 * → the existing webhook reconciles when Stripe confirms. The customer never
 * supplies an amount.
 */
export async function startInvoiceCheckoutByPortalToken(input: unknown): Promise<ActionResult<InvoicePortalCheckoutResult>> {
  try {
    const { token } = portalTokenActionSchema.parse(input);
    const origin = await requestOrigin();
    if (!origin) {
      return actionError(new Error("The checkout origin could not be determined from the request."));
    }
    const view = await createPortalRepo(db).findInvoiceByToken(token);
    if (!view) throw new NotFoundError("This customer link is not valid.");
    // The token resolved the tenant; the payment repo is scoped to that org.
    const payable = await createPaymentRepo(db, view.invoice.organizationId).getPayableInvoice(view.invoice.id);
    const created = await db.$transaction(async (tx) => {
      const pending = await createPaymentRepo(tx, view.invoice.organizationId).createPending({
        invoiceId: payable.id,
        amountCents: payable.balanceCents,
        method: "CARD",
        notes: "Opened via customer portal",
      });
      await writeAuditLog(
        {
          organizationId: view.invoice.organizationId,
          action: AuditAction.CREATE,
          entityType: "Payment",
          entityId: pending.id,
          before: toAuditJson(null),
          after: toAuditJson({
            invoiceId: pending.invoiceId,
            amountCents: pending.amountCents,
            method: pending.method,
            status: pending.status,
          }),
          metadata: toAuditJson({ source: "stripe_checkout_portal" }),
          actorUserId: null,
          actorClerkUserId: null,
        },
        tx,
      );
      return pending;
    });
    const session = await createInvoiceCheckoutSession({
      organizationId: view.invoice.organizationId,
      invoiceId: payable.id,
      invoiceNumber: payable.invoiceNumber,
      amountCents: payable.balanceCents,
      currency: view.organization.currency,
      metadata: {
        organizationId: view.invoice.organizationId,
        invoiceId: payable.id,
        paymentId: created.id,
      },
      successUrl: `${origin}/portal/invoice/${token}?payment=started`,
      cancelUrl: `${origin}/portal/invoice/${token}?payment=cancelled`,
    });
    return { ok: true, data: { url: session.url, paymentId: created.id } };
  } catch (err) {
    return actionError(err);
  }
}
