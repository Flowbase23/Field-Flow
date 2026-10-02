/**
 * Stripe webhook receiver — Phase 2 Slice P2-3 (mirrors the Clerk receiver's
 * structure: verify first, then idempotent handlers, then 200/500 semantics).
 *
 * - Signature verification via the `stripe-signature` header using
 *   STRIPE_WEBHOOK_SECRET (stripe SDK constructEvent). Any verification
 *   failure → 400; a missing secret → 500 (fail closed, nothing is trusted).
 * - The tenant id comes ONLY from the verified event's metadata
 *   (organizationId planted by our own checkout adapter) — the same trust
 *   model as the Clerk receiver using the Clerk org id. Events without our
 *   metadata, or with an unknown organizationId/invoiceId, are ACKNOWLEDGED
 *   WITHOUT WRITING (fail closed; a wrong guess must never create money).
 * - Handlers are idempotent: duplicate deliveries of
 *   payment_intent.succeeded / checkout.session.completed for an already
 *   SUCCEEDED ledger row are no-ops (200), so Stripe stops retrying.
 * - The PENDING Payment row is created by startStripeCheckout() when the
 *   session is opened; these handlers move it SUCCEEDED (+ reconcile the
 *   invoice in the same transaction) or FAILED. If a charge arrives with no
 *   PENDING row (checkout opened outside the app), a SUCCEEDED payment is
 *   recorded directly from the verified metadata — through the same guarded
 *   reconcile (overpay/payable guards still apply).
 *
 * PENDING LIVE VERIFICATION: exercised against real Stripe once the owner adds
 * STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET to the secrets (same gating as the
 * Clerk webhook E2E). Unit tests cover the handler logic against a mocked
 * adapter + in-memory db.
 */
import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { AuditAction } from "@prisma/client";
import { toAuditJson, writeAuditLog } from "@/server/audit";
import { db } from "@/server/db/client";
import { createPaymentRepo } from "@/server/repositories/payment.repo";
import {
  constructStripeEvent,
  stripePaymentIntentIdFromSession,
  type StripePaymentMetadata,
} from "@/server/stripe/adapter";
export const dynamic = "force-dynamic";

function log(level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
  const line = `[webhook:stripe] ${msg}`;
  if (level === "error") console.error(line, extra ?? "");
  else if (level === "warn") console.warn(line, extra ?? "");
  else console.log(line, extra ?? "");
}

function webhookMetadata(event: Stripe.Event): StripePaymentMetadata | null {
  const object = event.data.object as { metadata?: Partial<StripePaymentMetadata> | null };
  const metadata = object.metadata;
  if (!metadata?.organizationId || !metadata.invoiceId) return null;
  return {
    organizationId: metadata.organizationId,
    invoiceId: metadata.invoiceId,
    ...(metadata.paymentId ? { paymentId: metadata.paymentId } : {}),
  };
}

const WEBHOOK_AUDIT = { source: "stripe_webhook" } as const;

/**
 * Confirms one payment: finds the ledger row for the verified metadata and
 * moves it SUCCEEDED (+ reconcile). Returns true when a write happened.
 */
async function confirmPayment(metadata: StripePaymentMetadata, options: { now?: Date; stripePaymentIntentId?: string | null }): Promise<boolean> {
  const { organizationId, invoiceId, paymentId } = metadata;
  if (!paymentId) return false;
  const payment = await db.payment.findFirst({ where: { id: paymentId, organizationId } });
  if (!payment) {
    // The PENDING row vanished (voided while checkout was open?) — never guess.
    log("warn", `payment_intent succeeded but payment row not found (org=${organizationId}, paymentId=${paymentId})`);
    return false;
  }
  if (payment.invoiceId !== invoiceId) {
    log("error", `payment ${payment.id} metadata invoice mismatch — refusing`, { metadata });
    return false;
  }
  if (payment.status === "SUCCEEDED") return false; // Idempotent retry.
  await db.$transaction(async (tx) => {
    const repo = createPaymentRepo(tx, organizationId);
    const { payment: updated, invoiceBefore, invoiceAfter } = await repo.markSucceeded(payment.id, options);
    if (updated.status === "SUCCEEDED") {
      await writeAuditLog(
        {
          organizationId,
          action: AuditAction.STATUS_CHANGED,
          entityType: "Payment",
          entityId: updated.id,
          before: toAuditJson({ status: payment.status, paidCents: 0 }),
          after: toAuditJson({ status: updated.status, paidCents: updated.amountCents }),
          metadata: toAuditJson({ ...WEBHOOK_AUDIT, stripePaymentIntentId: updated.stripePaymentIntentId }),
          actorUserId: null,
          actorClerkUserId: null,
        },
        tx,
      );
      if (invoiceBefore && invoiceAfter) {
        await writeAuditLog(
          {
            organizationId,
            action: AuditAction.UPDATE,
            entityType: "Invoice",
            entityId: invoiceAfter.id,
            before: toAuditJson({ status: invoiceBefore.status, paidCents: invoiceBefore.paidCents, balanceCents: invoiceBefore.balanceCents }),
            after: toAuditJson({ status: invoiceAfter.status, paidCents: invoiceAfter.paidCents, balanceCents: invoiceAfter.balanceCents }),
            metadata: toAuditJson({ ...WEBHOOK_AUDIT, paymentId: updated.id }),
            actorUserId: null,
            actorClerkUserId: null,
          },
          tx,
        );
      }
    }
  });
  log("info", `payment ${payment.id} confirmed SUCCEEDED (org=${organizationId})`);
  return true;
}

/** Records a charge with no PENDING ledger row (checkout opened outside the app). */
async function recordFromWebhook(
  metadata: StripePaymentMetadata,
  amountCents: number,
  options: { now?: Date; stripePaymentIntentId?: string | null; stripeCheckoutSessionId?: string | null },
): Promise<boolean> {
  await db.$transaction(async (tx) => {
    const repo = createPaymentRepo(tx, metadata.organizationId);
    const { payment, invoiceBefore, invoiceAfter } = await repo.record(
      {
        invoiceId: metadata.invoiceId,
        amountCents,
        method: "CARD",
        notes: "Recorded from Stripe webhook",
      },
      options,
    );
    // Stamp the Stripe ids system-side (the record path has no client input).
    await tx.payment.updateMany({
      where: { id: payment.id, organizationId: metadata.organizationId },
      data: {
        ...(options.stripePaymentIntentId ? { stripePaymentIntentId: options.stripePaymentIntentId } : {}),
        ...(options.stripeCheckoutSessionId ? { stripeCheckoutSessionId: options.stripeCheckoutSessionId } : {}),
      },
    });
    await writeAuditLog(
      {
        organizationId: metadata.organizationId,
        action: AuditAction.CREATE,
        entityType: "Payment",
        entityId: payment.id,
        before: toAuditJson(null),
        after: toAuditJson({ amountCents: payment.amountCents, method: payment.method, status: payment.status }),
        metadata: toAuditJson({ ...WEBHOOK_AUDIT, stripePaymentIntentId: options.stripePaymentIntentId ?? null }),
        actorUserId: null,
        actorClerkUserId: null,
      },
      tx,
    );
    if (invoiceBefore && invoiceAfter) {
      await writeAuditLog(
        {
          organizationId: metadata.organizationId,
          action: AuditAction.UPDATE,
          entityType: "Invoice",
          entityId: invoiceAfter.id,
          before: toAuditJson({ status: invoiceBefore.status, paidCents: invoiceBefore.paidCents, balanceCents: invoiceBefore.balanceCents }),
          after: toAuditJson({ status: invoiceAfter.status, paidCents: invoiceAfter.paidCents, balanceCents: invoiceAfter.balanceCents }),
          metadata: toAuditJson({ ...WEBHOOK_AUDIT, paymentId: payment.id }),
          actorUserId: null,
          actorClerkUserId: null,
        },
        tx,
      );
    }
  });
  log("info", `recorded webhook payment for invoice ${metadata.invoiceId} (org=${metadata.organizationId})`);
  return true;
}

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const metadata = webhookMetadata({ type: "checkout.session.completed", data: { object: session } } as Stripe.Event);
  if (!metadata) {
    // Not an object this app opened (or missing metadata) — acknowledge, never guess.
    log("info", "checkout.session.completed without app metadata — ignored");
    return;
  }
  // Already-stamped PENDING row wins (created by startStripeCheckout).
  const pending = await db.payment.findFirst({ where: { organizationId: metadata.organizationId, stripeCheckoutSessionId: session.id } });
  if (pending) {
    await confirmPayment({ ...metadata, paymentId: pending.id }, {
      stripePaymentIntentId: stripePaymentIntentIdFromSession(session),
    });
    return;
  }
  // Out-of-app checkout: record directly from the verified session total.
  if (session.amount_total == null || session.amount_total <= 0) {
    log("warn", `checkout session ${session.id} has no positive amount_total — ignored`);
    return;
  }
  if (await db.payment.findFirst({ where: { organizationId: metadata.organizationId, stripeCheckoutSessionId: session.id } })) return;
  const invoice = await db.invoice.findFirst({ where: { id: metadata.invoiceId, organizationId: metadata.organizationId } });
  if (!invoice) {
    log("warn", `checkout session ${session.id} references unknown invoice ${metadata.invoiceId} — ignored`);
    return;
  }
  await recordFromWebhook(metadata, session.amount_total, {
    stripePaymentIntentId: stripePaymentIntentIdFromSession(session),
    stripeCheckoutSessionId: session.id,
  });
}

async function handlePaymentIntentSucceeded(intent: Stripe.PaymentIntent): Promise<void> {
  const metadata = webhookMetadata({ type: "payment_intent.succeeded", data: { object: intent } } as Stripe.Event);
  if (!metadata) {
    log("info", "payment_intent.succeeded without app metadata — ignored");
    return;
  }
  if (await confirmPayment(metadata, { stripePaymentIntentId: intent.id })) return;
  // No ledger row (or the row is not ours to confirm): only record when there
  // is no PENDING row and no previous SUCCEEDED row for this intent.
  const existing = await db.payment.findFirst({ where: { organizationId: metadata.organizationId, stripePaymentIntentId: intent.id } });
  if (existing) return; // handled, or already recorded — idempotent.
  if (intent.amount_received == null || intent.amount_received <= 0) {
    log("warn", `payment intent ${intent.id} has no positive amount_received — ignored`);
    return;
  }
  const invoice = await db.invoice.findFirst({ where: { id: metadata.invoiceId, organizationId: metadata.organizationId } });
  if (!invoice) {
    log("warn", `payment intent ${intent.id} references unknown invoice ${metadata.invoiceId} — ignored`);
    return;
  }
  await recordFromWebhook(metadata, intent.amount_received, { stripePaymentIntentId: intent.id });
}

async function handlePaymentIntentFailed(intent: Stripe.PaymentIntent): Promise<void> {
  const metadata = webhookMetadata({ type: "payment_intent.payment_failed", data: { object: intent } } as Stripe.Event);
  if (!metadata?.paymentId) {
    log("info", "payment_intent.payment_failed without app metadata — ignored");
    return;
  }
  const payment = await db.payment.findFirst({ where: { id: metadata.paymentId, organizationId: metadata.organizationId } });
  if (!payment || payment.status !== "PENDING") return; // Idempotent / not ours to move.
  await db.$transaction(async (tx) => {
    await createPaymentRepo(tx, metadata.organizationId).markFailed(payment.id);
    await writeAuditLog(
      {
        organizationId: metadata.organizationId,
        action: AuditAction.STATUS_CHANGED,
        entityType: "Payment",
        entityId: payment.id,
        before: toAuditJson({ status: payment.status }),
        after: toAuditJson({ status: "FAILED" }),
        metadata: toAuditJson({ ...WEBHOOK_AUDIT, stripePaymentIntentId: intent.id }),
        actorUserId: null,
        actorClerkUserId: null,
      },
      tx,
    );
  });
  log("info", `payment ${payment.id} marked FAILED (org=${metadata.organizationId})`);
}

export async function POST(req: Request): Promise<NextResponse> {
  const sig = req.headers.get("stripe-signature");
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    log("error", "STRIPE_WEBHOOK_SECRET is not configured — rejecting webhook");
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }
  if (!sig) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }
  const payload = await req.text();
  let event: Stripe.Event;
  try {
    event = await constructStripeEvent(payload, sig);
  } catch (err) {
    log("warn", "webhook signature verification failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "payment_intent.succeeded":
        await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;
      case "payment_intent.payment_failed":
        await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
        break;
      default:
        // charge.*, invoice.*, customer.* — nothing to sync locally.
        log("info", `ignored event type: ${event.type}`);
    }
  } catch (err) {
    log("error", `handler failed for ${event.type}`, err);
    // Return 500 so Stripe retries with backoff (the handlers are idempotent).
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
