/**
 * Stripe adapter tests (Phase 2 Slice P2-3). The SDK is exercised OFFLINE:
 * signature verification uses stripe.webhooks.generateTestHeaderStringAsync + the
 * real constructEvent path with dummy keys — no network, no real secrets.
 * The env-gating (fail closed on missing keys) is the live-Stripe contract.
 */
import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  StripeNotConfiguredError,
  constructStripeEvent,
  isStripeConfigured,
  isStripeWebhookConfigured,
  stripePaymentIntentIdFromSession,
  stripePublishableKey,
  stripeSecretKey,
  stripeWebhookSecret,
} from "@/server/stripe/adapter";

const SECRET_KEY = "sk_test_dummy_key";
const WEBHOOK_SECRET = "whsec_dummy_secret";
const PAYLOAD = JSON.stringify({ id: "evt_1", object: "event", type: "payment_intent.succeeded", data: { object: {} } });
const sdk = new Stripe(SECRET_KEY); // offline: only used to mint test signatures

describe("env gating (fail closed)", () => {
  it("reports unconfigured and throws when the keys are missing", async () => {
    const previousSecret = process.env.STRIPE_SECRET_KEY;
    const previousWebhook = process.env.STRIPE_WEBHOOK_SECRET;
    const previousPublishable = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    try {
      expect(isStripeConfigured()).toBe(false);
      expect(isStripeWebhookConfigured()).toBe(false);
      expect(stripeSecretKey()).toBeUndefined();
      expect(stripeWebhookSecret()).toBeUndefined();
      expect(stripePublishableKey()).toBeUndefined();
      // getStripe via constructStripeEvent fails closed with 501 semantics.
      await expect(constructStripeEvent(PAYLOAD, "t=1,v1=abc")).rejects.toThrow(StripeNotConfiguredError);
    } finally {
      if (previousSecret !== undefined) process.env.STRIPE_SECRET_KEY = previousSecret;
      if (previousWebhook !== undefined) process.env.STRIPE_WEBHOOK_SECRET = previousWebhook;
      if (previousPublishable !== undefined) process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = previousPublishable;
    }
  });
});

describe("signature verification (real constructEvent, dummy keys)", () => {
  it("accepts a correctly-signed payload", async () => {
    process.env.STRIPE_SECRET_KEY = SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const signature = await sdk.webhooks.generateTestHeaderStringAsync({ payload: PAYLOAD, secret: WEBHOOK_SECRET });
    const event = await constructStripeEvent(PAYLOAD, signature);
    expect(event.type).toBe("payment_intent.succeeded");
  });
  it("rejects a signature minted for a different secret", async () => {
    process.env.STRIPE_SECRET_KEY = SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const signature = await sdk.webhooks.generateTestHeaderStringAsync({ payload: PAYLOAD, secret: "whsec_attacker" });
    await expect(constructStripeEvent(PAYLOAD, signature)).rejects.toThrow();
  });
  it("rejects a tampered payload", async () => {
    process.env.STRIPE_SECRET_KEY = SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const signature = await sdk.webhooks.generateTestHeaderStringAsync({ payload: PAYLOAD, secret: WEBHOOK_SECRET });
    const tampered = PAYLOAD.replace("succeeded", "failed");
    await expect(constructStripeEvent(tampered, signature)).rejects.toThrow();
  });
  it("fails closed when STRIPE_WEBHOOK_SECRET is set but empty", async () => {
    process.env.STRIPE_SECRET_KEY = SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = "   ";
    expect(isStripeWebhookConfigured()).toBe(false);
    await expect(constructStripeEvent(PAYLOAD, "t=1,v1=abc")).rejects.toThrow(StripeNotConfiguredError);
  });
});

describe("payment intent normalization", () => {
  it("reads the intent id from either representation Stripe sends", () => {
    expect(stripePaymentIntentIdFromSession({ payment_intent: "pi_123" } as never)).toBe("pi_123");
    expect(stripePaymentIntentIdFromSession({ payment_intent: { id: "pi_456" } } as never)).toBe("pi_456");
    expect(stripePaymentIntentIdFromSession({} as never)).toBeNull();
  });
});
