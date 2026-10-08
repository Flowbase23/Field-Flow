/**
 * Payment server actions — Phase 2 Slice P2-3. Organization identity comes
 * solely from Clerk-backed requirePermission(); the browser payloads have no
 * organizationId field. Each money-moving mutation and its audit rows share
 * one database transaction, and Payments are reached only through the
 * tenant-scoped payment repo (immutable ledger — there is no update path).
 */
"use server";
import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { actionError, NotFoundError, type ActionResult } from "@/lib/errors";
import { toAuditJson, writeAuditLog } from "@/server/audit";
import { requestOrigin } from "@/server/http-origin";
import { requirePermission } from "@/server/auth/require-org";
import { db } from "@/server/db/client";
import { createPaymentRepo } from "@/server/repositories/payment.repo";
import {
  createInvoiceCheckoutSession,
} from "@/server/stripe/adapter";
import {
  paymentReadSchema,
  paymentRefundSchema,
  paymentStripeCheckoutSchema,
  paymentVoidSchema,
  type PaymentListActionInput,
  paymentListActionSchema,
  paymentRecordSchema,
} from "../schemas";

export interface PaymentActionResult {
  id: string;
  invoiceId: string;
  status: string;
  amountCents: number;
  method: string;
}
/** The invoice reconcile this payment caused (read-back for the UI). */
export interface PaymentInvoiceReconcile {
  invoiceId: string;
  invoiceNumber: number;
  status: string;
  paidCents: number;
  balanceCents: number;
}
export interface PaymentDetailActionResult {
  id: string;
  invoiceId: string;
  invoiceNumber: number;
  customerId: string | null;
  customerName: string | null;
  status: string;
  method: string;
  amountCents: number;
  notes: string | null;
  appliedAt: string | null;
  createdAt: string;
}
export interface PaymentCheckoutResult {
  /** Stripe-hosted URL the browser is redirected to. */
  url: string;
  paymentId: string;
}

function paymentSnapshotFields(payment: {
  invoiceId: string;
  customerId: string | null;
  amountCents: number;
  method: string;
  status: string;
  notes: string | null;
  appliedAt: Date | null;
  stripePaymentIntentId: string | null;
  stripeCheckoutSessionId: string | null;
}) {
  return {
    invoiceId: payment.invoiceId,
    customerId: payment.customerId,
    amountCents: payment.amountCents,
    method: payment.method,
    status: payment.status,
    notes: payment.notes,
    appliedAt: payment.appliedAt?.toISOString() ?? null,
    stripePaymentIntentId: payment.stripePaymentIntentId,
    stripeCheckoutSessionId: payment.stripeCheckoutSessionId,
  };
}
function invoiceMoneySnapshot(invoice: {
  invoiceNumber: number;
  status: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  paidAt: Date | null;
}) {
  return {
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    totalCents: invoice.totalCents,
    paidCents: invoice.paidCents,
    balanceCents: invoice.balanceCents,
    paidAt: invoice.paidAt?.toISOString() ?? null,
  };
}
function revalidatePayments(orgSlug: string, paymentId?: string, invoiceId?: string): void {
  revalidatePath(`/${orgSlug}/payments`);
  if (paymentId) revalidatePath(`/${orgSlug}/payments/${paymentId}`);
  if (invoiceId) revalidatePath(`/${orgSlug}/invoices/${invoiceId}`);
}

/**
 * The absolute origin the checkout must return to (Stripe requires absolute
 * URLs). Derived from the request's Host/x-forwarded headers — the same
 * server-side trust level the rest of the app uses; never client-supplied in
 * the payload. (Shared helper also used by the customer-portal checkout.)
 */

/** Tenant-scoped read primitive. PAYMENT_READ is enforced independently of any UI. */
export async function getPayment(input: unknown): Promise<ActionResult<PaymentDetailActionResult>> {
  try {
    const ctx = await requirePermission(Permission.PAYMENT_READ);
    const { id } = paymentReadSchema.parse(input);
    const payment = await createPaymentRepo(db, ctx.organizationId).getDetail(id);
    if (!payment) throw new NotFoundError("Payment not found in this organization.");
    const customerName = payment.customer
      ? (payment.customer.companyName ?? [payment.customer.firstName, payment.customer.lastName].filter(Boolean).join(" ")) || null
      : null;
    return {
      ok: true,
      data: {
        id: payment.id,
        invoiceId: payment.invoiceId,
        invoiceNumber: payment.invoice.invoiceNumber,
        customerId: payment.customerId,
        customerName,
        status: payment.status,
        method: payment.method,
        amountCents: payment.amountCents,
        notes: payment.notes,
        appliedAt: payment.appliedAt.toISOString(),
        createdAt: payment.createdAt.toISOString(),
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

/** Tenant-scoped ledger list (status/method/invoice/customer filters, pagination). */
export async function getPayments(input: unknown): Promise<ActionResult<PaymentDetailActionResult[]>> {
  try {
    const ctx = await requirePermission(Permission.PAYMENT_READ);
    const params = paymentListActionSchema.parse(input) as PaymentListActionInput;
    const repo = createPaymentRepo(db, ctx.organizationId);
    const rows = await repo.list(params);
    return {
      ok: true,
      data: rows.map((payment) => ({
        id: payment.id,
        invoiceId: payment.invoiceId,
        invoiceNumber: payment.invoice.invoiceNumber,
        customerId: payment.customerId,
        customerName: payment.customer
          ? (payment.customer.companyName ?? [payment.customer.firstName, payment.customer.lastName].filter(Boolean).join(" ")) || null
          : null,
        status: payment.status,
        method: payment.method,
        amountCents: payment.amountCents,
        notes: payment.notes,
        appliedAt: payment.appliedAt.toISOString(),
        createdAt: payment.createdAt.toISOString(),
      })),
    };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Record a manual payment (cash/check/ACH/…): creates the SUCCEEDED ledger row
 * and reconciles the invoice in ONE transaction (CREATE + Invoice UPDATE audit).
 */
export async function recordPayment(input: unknown): Promise<ActionResult<PaymentActionResult & { invoice: PaymentInvoiceReconcile | null }>> {
  try {
    const ctx = await requirePermission(Permission.PAYMENT_CREATE);
    const data = paymentRecordSchema.parse(input);
    const result = await db.$transaction(async (tx) => {
      const repo = createPaymentRepo(tx, ctx.organizationId);
      const { payment, invoiceBefore, invoiceAfter } = await repo.record(data);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.CREATE,
          entityType: "Payment",
          entityId: payment.id,
          before: toAuditJson(null),
          after: toAuditJson(paymentSnapshotFields(payment)),
          metadata: toAuditJson({ source: "manual" }),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      if (invoiceAfter) {
        await writeAuditLog(
          {
            organizationId: ctx.organizationId,
            action: AuditAction.UPDATE,
            entityType: "Invoice",
            entityId: invoiceAfter.id,
            before: toAuditJson(invoiceMoneySnapshot({ ...invoiceAfter, status: invoiceBefore?.status ?? invoiceAfter.status, paidCents: invoiceBefore?.paidCents ?? invoiceAfter.paidCents, balanceCents: invoiceBefore?.balanceCents ?? invoiceAfter.balanceCents })),
            after: toAuditJson(invoiceMoneySnapshot(invoiceAfter)),
            metadata: toAuditJson({ paymentId: payment.id, source: "manual" }),
            actorUserId: ctx.userId,
            actorClerkUserId: ctx.clerkUserId,
          },
          tx,
        );
      }
      return { payment, invoiceAfter };
    });
    revalidatePayments(ctx.organization.slug, result.payment.id, result.payment.invoiceId);
    return {
      ok: true,
      data: {
        id: result.payment.id,
        invoiceId: result.payment.invoiceId,
        status: result.payment.status,
        amountCents: result.payment.amountCents,
        method: result.payment.method,
        invoice: result.invoiceAfter
          ? {
              invoiceId: result.invoiceAfter.id,
              invoiceNumber: result.invoiceAfter.invoiceNumber,
              status: result.invoiceAfter.status,
              paidCents: result.invoiceAfter.paidCents,
              balanceCents: result.invoiceAfter.balanceCents,
            }
          : null,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Void a payment: PENDING → VOIDED (nothing moved) or SUCCEEDED → VOIDED
 * (reverses the invoice reconcile in the same transaction). STATUS_CHANGED
 * audit (+ Invoice UPDATE audit when money reversed).
 */
export async function voidPayment(input: unknown): Promise<ActionResult<PaymentActionResult & { invoice: PaymentInvoiceReconcile | null }>> {
  try {
    const ctx = await requirePermission(Permission.PAYMENT_VOID);
    const { id } = paymentVoidSchema.parse(input);
    const result = await db.$transaction(async (tx) => {
      const repo = createPaymentRepo(tx, ctx.organizationId);
      const existing = await repo.getById(id);
      if (!existing) throw new NotFoundError("Payment not found in this organization.");
      const { payment, invoiceBefore, invoiceAfter } = await repo.void(id);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.STATUS_CHANGED,
          entityType: "Payment",
          entityId: payment.id,
          before: toAuditJson(paymentSnapshotFields(existing)),
          after: toAuditJson(paymentSnapshotFields(payment)),
          metadata: toAuditJson({ source: "manual" }),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      if (invoiceAfter) {
        await writeAuditLog(
          {
            organizationId: ctx.organizationId,
            action: AuditAction.UPDATE,
            entityType: "Invoice",
            entityId: invoiceAfter.id,
            before: toAuditJson(invoiceMoneySnapshot({ ...invoiceAfter, status: invoiceBefore?.status ?? invoiceAfter.status, paidCents: invoiceBefore?.paidCents ?? invoiceAfter.paidCents, balanceCents: invoiceBefore?.balanceCents ?? invoiceAfter.balanceCents })),
            after: toAuditJson(invoiceMoneySnapshot(invoiceAfter)),
            metadata: toAuditJson({ paymentId: payment.id, source: "manual" }),
            actorUserId: ctx.userId,
            actorClerkUserId: ctx.clerkUserId,
          },
          tx,
        );
      }
      return { payment, invoiceAfter };
    });
    revalidatePayments(ctx.organization.slug, result.payment.id, result.payment.invoiceId);
    return {
      ok: true,
      data: {
        id: result.payment.id,
        invoiceId: result.payment.invoiceId,
        status: result.payment.status,
        amountCents: result.payment.amountCents,
        method: result.payment.method,
        invoice: result.invoiceAfter
          ? {
              invoiceId: result.invoiceAfter.id,
              invoiceNumber: result.invoiceAfter.invoiceNumber,
              status: result.invoiceAfter.status,
              paidCents: result.invoiceAfter.paidCents,
              balanceCents: result.invoiceAfter.balanceCents,
            }
          : null,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

/** Refund a SUCCEEDED payment: reverses the reconcile, ledger row becomes REFUNDED. */
export async function refundPayment(input: unknown): Promise<ActionResult<PaymentActionResult & { invoice: PaymentInvoiceReconcile | null }>> {
  try {
    const ctx = await requirePermission(Permission.PAYMENT_REFUND);
    const { id } = paymentRefundSchema.parse(input);
    const result = await db.$transaction(async (tx) => {
      const repo = createPaymentRepo(tx, ctx.organizationId);
      const existing = await repo.getById(id);
      if (!existing) throw new NotFoundError("Payment not found in this organization.");
      const { payment, invoiceBefore, invoiceAfter } = await repo.refund(id);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.STATUS_CHANGED,
          entityType: "Payment",
          entityId: payment.id,
          before: toAuditJson(paymentSnapshotFields(existing)),
          after: toAuditJson(paymentSnapshotFields(payment)),
          metadata: toAuditJson({ source: "manual" }),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      if (invoiceAfter) {
        await writeAuditLog(
          {
            organizationId: ctx.organizationId,
            action: AuditAction.UPDATE,
            entityType: "Invoice",
            entityId: invoiceAfter.id,
            before: toAuditJson(invoiceMoneySnapshot({ ...invoiceAfter, status: invoiceBefore?.status ?? invoiceAfter.status, paidCents: invoiceBefore?.paidCents ?? invoiceAfter.paidCents, balanceCents: invoiceBefore?.balanceCents ?? invoiceAfter.balanceCents })),
            after: toAuditJson(invoiceMoneySnapshot(invoiceAfter)),
            metadata: toAuditJson({ paymentId: payment.id, source: "manual" }),
            actorUserId: ctx.userId,
            actorClerkUserId: ctx.clerkUserId,
          },
          tx,
        );
      }
      return { payment, invoiceAfter };
    });
    revalidatePayments(ctx.organization.slug, result.payment.id, result.payment.invoiceId);
    return {
      ok: true,
      data: {
        id: result.payment.id,
        invoiceId: result.payment.invoiceId,
        status: result.payment.status,
        amountCents: result.payment.amountCents,
        method: result.payment.method,
        invoice: result.invoiceAfter
          ? {
              invoiceId: result.invoiceAfter.id,
              invoiceNumber: result.invoiceAfter.invoiceNumber,
              status: result.invoiceAfter.status,
              paidCents: result.invoiceAfter.paidCents,
              balanceCents: result.invoiceAfter.balanceCents,
            }
          : null,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Open a Stripe hosted checkout for one invoice's outstanding balance: creates
 * the PENDING ledger row (no money moved) and returns the hosted URL.
 * LIVE-GATED: throws StripeNotConfiguredError (→ 501 code) until the owner
 * adds STRIPE_SECRET_KEY to the deployment secrets.
 */
export async function startStripeCheckout(input: unknown): Promise<ActionResult<PaymentCheckoutResult>> {
  try {
    const ctx = await requirePermission(Permission.PAYMENT_CREATE);
    const { invoiceId } = paymentStripeCheckoutSchema.parse(input);
    const repo = createPaymentRepo(db, ctx.organizationId);
    const invoice = await repo.getPayableInvoice(invoiceId);
    const origin = await requestOrigin();
    if (!origin) {
      return actionError(new Error("The checkout origin could not be determined from the request."));
    }
    const created = await db.$transaction(async (tx) => {
      const txRepo = createPaymentRepo(tx, ctx.organizationId);
      const pending = await txRepo.createPending({
        invoiceId: invoice.id,
        amountCents: invoice.balanceCents,
        method: "CARD",
        notes: "Opened via Stripe checkout",
      });
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.CREATE,
          entityType: "Payment",
          entityId: pending.id,
          before: toAuditJson(null),
          after: toAuditJson(paymentSnapshotFields(pending)),
          metadata: toAuditJson({ source: "stripe_checkout" }),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      return pending;
    });
    const session = await createInvoiceCheckoutSession({
      organizationId: ctx.organizationId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amountCents: invoice.balanceCents,
      currency: ctx.organization.currency,
      metadata: {
        organizationId: ctx.organizationId,
        invoiceId: invoice.id,
        paymentId: created.id,
      },
      successUrl: `${origin}/${ctx.organization.slug}/invoices/${invoice.id}?payment=started`,
      cancelUrl: `${origin}/${ctx.organization.slug}/invoices/${invoice.id}?payment=cancelled`,
    });
    revalidatePayments(ctx.organization.slug, created.id, invoice.id);
    return { ok: true, data: { url: session.url, paymentId: created.id } };
  } catch (err) {
    return actionError(err);
  }
}
