/**
 * Thin Stripe adapter (Phase 2 Slice P2-3).
 *
 * Everything Stripe-flavored goes through this ONE server module so the rest
 * of the code (actions, webhook, tests) never touches the SDK directly and
 * unit tests can mock these seams.
 *
 * LIVE STRIPE IS GATED ON ENVIRONMENT KEYS — the owner adds these to the
 * deployment secrets (same model as the Clerk keys):
 *   STRIPE_SECRET_KEY                 — server-side API calls
 *   STRIPE_WEBHOOK_SECRET             — webhook signature verification
 *   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY — reserved for future browser flows
 * No key is ever hardcoded or invented: every helper FAILS CLOSED with
 * StripeNotConfiguredError when its env var is missing, and the UI hides the
 * Stripe entry points when `isStripeConfigured()` is false.
 */
import Stripe from "stripe";
import { AppError } from "@/lib/errors";

/** 501 — Stripe is intentionally unconfigured (keys not provisioned yet). */
export class StripeNotConfiguredError extends AppError {
  constructor(message = "Stripe is not configured yet. Add the Stripe keys to the deployment secrets to enable online payments.") {
    super(message, { code: "STRIPE_NOT_CONFIGURED", statusCode: 501 });
  }
}

export function stripeSecretKey(): string | undefined {
  const value = process.env.STRIPE_SECRET_KEY;
  return value && value.trim() !== "" ? value : undefined;
}
export function stripeWebhookSecret(): string | undefined {
  const value = process.env.STRIPE_WEBHOOK_SECRET;
  return value && value.trim() !== "" ? value : undefined;
}
export function stripePublishableKey(): string | undefined {
  const value = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  return value && value.trim() !== "" ? value : undefined;
}
export function isStripeConfigured(): boolean {
  return stripeSecretKey() !== undefined;
}
export function isStripeWebhookConfigured(): boolean {
  return stripeWebhookSecret() !== undefined;
}

let cachedClient: Stripe | null = null;
/** Lazily-constructed shared Stripe client; throws when unconfigured. */
export function getStripe(): Stripe {
  const key = stripeSecretKey();
  if (!key) throw new StripeNotConfiguredError();
  if (!cachedClient) cachedClient = new Stripe(key);
  return cachedClient;
}

/** Metadata keys the app plants on every Stripe object it creates. The
 *  webhook trusts them ONLY after signature verification. */
export interface StripePaymentMetadata {
  organizationId: string;
  invoiceId: string;
  /** Our Payment row id (PENDING) — lets the webhook find the ledger row. */
  paymentId?: string;
}

export interface InvoiceCheckoutSessionInput {
  organizationId: string;
  invoiceId: string;
  invoiceNumber: number;
  /** The outstanding balance — the only amount this app ever charges. */
  amountCents: number;
  currency: string;
  metadata: StripePaymentMetadata;
  successUrl: string;
  cancelUrl: string;
}
export interface InvoiceCheckoutSession {
  id: string;
  url: string;
  amountCents: number;
}

/**
 * Creates a hosted Stripe Checkout Session charging exactly `amountCents` for
 * one invoice. Checkout (not a raw PaymentIntent) so no card data ever touches
 * the app and Stripe hosts PCI scope.
 */
export async function createInvoiceCheckoutSession(input: InvoiceCheckoutSessionInput): Promise<InvoiceCheckoutSession> {
  const stripe = getStripe();
  const metadata = input.metadata;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.currency.toLowerCase(),
          unit_amount: input.amountCents,
          product_data: { name: `Invoice #${input.invoiceNumber}` },
        },
      },
    ],
    // The same metadata on BOTH objects: checkout.session.completed carries
    // the session's, payment_intent.succeeded carries the intent's (one of
    // the two may arrive first; both must resolve to our ledger row).
    metadata: { ...metadata },
    payment_intent_data: { metadata: { ...metadata } },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
  if (!session.url) {
    throw new AppError("Stripe did not return a checkout URL.", { code: "STRIPE_ERROR", statusCode: 502 });
  }
  return { id: session.id, url: session.url, amountCents: session.amount_total ?? input.amountCents };
}

/**
 * Verifies the `stripe-signature` header against STRIPE_WEBHOOK_SECRET and
 * returns the parsed event. Throws on ANY mismatch — callers map that to 400.
 * Uses constructEventAsync, the variant Stripe ships for runtimes whose
 * WebCrypto is async-only (Bun/Workers) — it behaves identically on the Node
 * production server.
 */
export async function constructStripeEvent(payload: string, signature: string): Promise<Stripe.Event> {
  const secret = stripeWebhookSecret();
  if (!secret) throw new StripeNotConfiguredError();
  return getStripe().webhooks.constructEventAsync(payload, signature, secret);
}

/** Normalizes the PaymentIntent id from either representation Stripe sends. */
export function stripePaymentIntentIdFromSession(session: Stripe.Checkout.Session): string | null {
  if (typeof session.payment_intent === "string") return session.payment_intent;
  return session.payment_intent?.id ?? null;
}
