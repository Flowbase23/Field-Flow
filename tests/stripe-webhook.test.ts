/**
 * Stripe webhook receiver tests (src/app/api/webhooks/stripe/route.ts).
 *
 * IN-MEMORY ONLY, mirroring tests/authorization/invoice-actions.test.ts: the
 * shared Prisma db singleton and the audit writer are replaced with bun:test
 * `mock.module()` fakes (bun's runner ignores vi.mock — this file is excluded
 * in vitest.config.ts and runs under `bun test`, the project gate).
 *
 * Signature verification is REAL: dummy env keys (STRIPE_SECRET_KEY /
 * STRIPE_WEBHOOK_SECRET) + the Stripe SDK's own constructEvent against
 * signatures minted with generateTestHeaderString. No network, no real keys.
 *
 * What this proves:
 * - the receiver fails closed: 500 with no secret, 400 with no/invalid
 *   signature header, and only signed events reach the handlers;
 * - tenant identity comes ONLY from verified metadata — events without our
 *   organizationId/invoiceId metadata are acknowledged without writing;
 * - a confirmed charge moves the PENDING ledger row SUCCEEDED and reconciles
 *   the invoice in one transaction (with audit rows);
 * - duplicate deliveries are idempotent (200, no second reconcile).
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

const SECRET_KEY = "sk_test_dummy_key";
const WEBHOOK_SECRET = "whsec_dummy_secret";
const ORG_A = "org-local-a";
const CUST_A = "custA000000000000000000001a";
const INV_A = "cinvA00000000000000000001a";
const PAY_A = "cpayA00000000000000000001a";

process.env.STRIPE_SECRET_KEY = SECRET_KEY;
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

mock.module("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }),
  },
}));
// NOTE: @/server/audit is deliberately NOT mocked — bun's mock.module
// registrations leak across test files in a full `bun test` run, and a
// closure-based audit mock would capture THIS file's state array for other
// suites. The REAL writeAuditLog routes through the db fake's
// auditLog.create below instead.

/** In-memory Invoice/Payment tables, scoped by org (audit captured above). */
const state = {
  invoices: [] as Array<Record<string, any>>,
  payments: [] as Array<Record<string, any>>,
  audit: [] as Array<Record<string, any>>,
};
function resetState() {
  state.invoices = [
    { id: INV_A, organizationId: ORG_A, invoiceNumber: 4, customerId: CUST_A, status: "SENT", totalCents: 10000, paidCents: 0, balanceCents: 10000, paidAt: null },
    { id: "cinvB00000000000000000001b", organizationId: "org-foreign", invoiceNumber: 99, customerId: "custB000000000000000000001b", status: "SENT", totalCents: 1, paidCents: 0, balanceCents: 1, paidAt: null },
  ];
  state.payments = [];
  state.audit = [];
}
function match(where: any, rows: Array<Record<string, any>>): Array<Record<string, any>> {
  return rows.filter((row) => {
    if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.invoiceId !== undefined && row.invoiceId !== where.invoiceId) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.paidCents !== undefined && row.paidCents !== where.paidCents) return false;
    if (where.stripeCheckoutSessionId !== undefined && row.stripeCheckoutSessionId !== where.stripeCheckoutSessionId) return false;
    if (where.stripePaymentIntentId !== undefined && row.stripePaymentIntentId !== where.stripePaymentIntentId) return false;
    return true;
  });
}
mock.module("@/server/db/client", () => {
  const db: Record<string, any> = {
    $executeRaw: async () => 0, // per-org advisory lock — recorded, no result set
    invoice: {
      findFirst: async ({ where }: any) => match(where, state.invoices)[0] ?? null,
      updateMany: async ({ where, data }: any) => {
        const row = match(where, state.invoices)[0];
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    payment: {
      findFirst: async ({ where }: any) => match(where, state.payments)[0] ?? null,
      create: async ({ data }: any) => {
        const created = { id: `cpayA00000000000000000001${state.payments.length + 1}`, stripePaymentIntentId: null, stripeCheckoutSessionId: null, notes: null, ...data };
        state.payments.push(created);
        return created;
      },
      updateMany: async ({ where, data }: any) => {
        const row = match(where, state.payments)[0];
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    // The REAL @/server/audit writeAuditLog lands here (called with the tx from
    // db.$transaction), so audit assertions observe this array.
    auditLog: {
      create: async ({ data }: any) => {
        state.audit.push(data);
        return data;
      },
    },
  };
  // A real TransactionClient has the models but NO $transaction — the tx handed
  // to the repo must not re-trigger the client-mode $transaction wrap.
  const txClient: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(db)) {
    if (key !== "$transaction") txClient[key] = value;
  }
  db.$transaction = async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(txClient);
  return { db };
});

// Import the route under test AFTER the mocks are registered.
const { POST } = await import("@/app/api/webhooks/stripe/route");
import Stripe from "stripe";
const sdk = new Stripe(SECRET_KEY); // offline — only mints test signatures

function seedPending(overrides: Partial<Record<string, any>> = {}): Record<string, any> {
  const created = {
    id: PAY_A,
    organizationId: ORG_A,
    invoiceId: INV_A,
    customerId: CUST_A,
    amountCents: 10000,
    method: "CARD",
    status: "PENDING",
    notes: null,
    stripePaymentIntentId: null,
    stripeCheckoutSessionId: null,
    appliedAt: new Date("2026-10-02T10:00:00.000Z"),
    ...overrides,
  };
  state.payments.push(created);
  return created;
}
/** Mints a signed POST request the way Stripe would deliver it. */
async function signedRequest(event: Record<string, unknown>, secret = WEBHOOK_SECRET): Promise<Request> {
  const payload = JSON.stringify(event);
  const signature = await sdk.webhooks.generateTestHeaderStringAsync({ payload, secret });
  return new Request("https://fieldflow.test/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });
}
const intentEvent = (intent: Record<string, unknown>) => ({
  id: "evt_1",
  object: "event",
  type: "payment_intent.succeeded",
  data: { object: intent },
});

beforeEach(() => {
  resetState();
});

describe("webhook trust boundary", () => {
  it("rejects everything with 500 while STRIPE_WEBHOOK_SECRET is unset (fail closed)", async () => {
    const previous = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const response = await POST(await signedRequest(intentEvent({ id: "pi_x", amount_received: 100, metadata: {} })));
      expect(response.status).toBe(500);
      expect(state.audit).toHaveLength(0);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = previous;
    }
  });
  it("rejects a request with no signature header", async () => {
    const payload = JSON.stringify(intentEvent({ id: "pi_x" }));
    const response = await POST(new Request("https://fieldflow.test/api/webhooks/stripe", { method: "POST", body: payload }));
    expect(response.status).toBe(400);
    expect(state.audit).toHaveLength(0);
  });
  it("rejects an event signed with a different secret", async () => {
    const response = await POST(await signedRequest(intentEvent({ id: "pi_x", amount_received: 100, metadata: {} }), "whsec_attacker"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid signature" });
    expect(state.audit).toHaveLength(0);
  });
  it("acknowledges events without the app's metadata without writing (never guesses)", async () => {
    const response = await POST(await signedRequest(intentEvent({ id: "pi_x", amount_received: 100, metadata: { organizationId: ORG_A } })));
    expect(response.status).toBe(200);
    expect(state.payments).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
  it("ignores unknown event types with 200", async () => {
    const response = await POST(await signedRequest({ id: "evt_2", object: "event", type: "charge.refunded", data: { object: { id: "ch_1" } } }));
    expect(response.status).toBe(200);
    expect(state.audit).toHaveLength(0);
  });
});

describe("payment_intent.succeeded", () => {
  it("confirms the PENDING ledger row, reconciles the invoice and audits both sides", async () => {
    const pending = seedPending();
    const response = await POST(await signedRequest(intentEvent({
      id: "pi_1",
      amount_received: 10000,
      metadata: { organizationId: ORG_A, invoiceId: INV_A, paymentId: pending.id },
    })));
    expect(response.status).toBe(200);
    expect(pending.status).toBe("SUCCEEDED");
    expect(pending.stripePaymentIntentId).toBe("pi_1");
    const invoice = state.invoices.find((row) => row.id === INV_A)!;
    expect(invoice.paidCents).toBe(10000);
    expect(invoice.balanceCents).toBe(0);
    expect(invoice.status).toBe("PAID");
    expect(invoice.paidAt).toBeTruthy();
    const paymentAudits = state.audit.filter((row) => row.entityType === "Payment");
    const invoiceAudits = state.audit.filter((row) => row.entityType === "Invoice");
    expect(paymentAudits).toHaveLength(1);
    expect(paymentAudits[0]!.action).toBe("STATUS_CHANGED");
    expect(invoiceAudits).toHaveLength(1);
    expect(invoiceAudits[0]!.after.balanceCents).toBe(0);
  });
  it("is idempotent on duplicate deliveries (already-SUCCEEDED row: no second reconcile)", async () => {
    const pending = seedPending({ status: "SUCCEEDED", stripePaymentIntentId: "pi_1" });
    state.invoices.find((row) => row.id === INV_A)!.status = "PAID";
    state.invoices.find((row) => row.id === INV_A)!.paidCents = 10000;
    state.invoices.find((row) => row.id === INV_A)!.balanceCents = 0;
    const response = await POST(await signedRequest(intentEvent({
      id: "pi_1",
      amount_received: 10000,
      metadata: { organizationId: ORG_A, invoiceId: INV_A, paymentId: pending.id },
    })));
    expect(response.status).toBe(200);
    expect(state.audit).toHaveLength(0); // no new writes
    expect(state.invoices.find((row) => row.id === INV_A)!.paidCents).toBe(10000);
  });
  it("records an out-of-app charge directly from verified metadata (no PENDING row)", async () => {
    const response = await POST(await signedRequest(intentEvent({
      id: "pi_2",
      amount_received: 4000,
      metadata: { organizationId: ORG_A, invoiceId: INV_A },
    })));
    expect(response.status).toBe(200);
    expect(state.payments).toHaveLength(1);
    const created = state.payments[0]!;
    expect(created.status).toBe("SUCCEEDED");
    expect(created.method).toBe("CARD");
    expect(created.stripePaymentIntentId).toBe("pi_2");
    expect(state.invoices.find((row) => row.id === INV_A)!.balanceCents).toBe(6000);
    expect(state.audit.some((row) => row.entityType === "Payment" && row.action === "CREATE")).toBe(true);
  });
  it("refuses to create money for an unknown invoice (acknowledges, writes nothing)", async () => {
    const response = await POST(await signedRequest(intentEvent({
      id: "pi_3",
      amount_received: 4000,
      metadata: { organizationId: ORG_A, invoiceId: "cinvMissing00000000000001a" },
    })));
    expect(response.status).toBe(200);
    expect(state.payments).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
});

describe("payment_intent.payment_failed", () => {
  it("moves only the app's own PENDING row to FAILED", async () => {
    const pending = seedPending();
    const response = await POST(await signedRequest({
      id: "evt_3",
      object: "event",
      type: "payment_intent.payment_failed",
      data: { object: { id: "pi_4", metadata: { organizationId: ORG_A, invoiceId: INV_A, paymentId: pending.id } } },
    }));
    expect(response.status).toBe(200);
    expect(pending.status).toBe("FAILED");
    expect(state.audit.filter((row) => row.entityType === "Payment" && row.action === "STATUS_CHANGED")).toHaveLength(1);
    expect(state.invoices.find((row) => row.id === INV_A)!.paidCents).toBe(0); // no money moved
  });
});

describe("checkout.session.completed", () => {
  it("confirms the PENDING row opened by startStripeCheckout and stamps the intent", async () => {
    const pending = seedPending({ stripeCheckoutSessionId: "cs_1" });
    const response = await POST(await signedRequest({
      id: "evt_4",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_1", amount_total: 10000, payment_intent: "pi_5", metadata: { organizationId: ORG_A, invoiceId: INV_A, paymentId: pending.id } } },
    }));
    expect(response.status).toBe(200);
    expect(pending.status).toBe("SUCCEEDED");
    expect(pending.stripePaymentIntentId).toBe("pi_5");
    expect(state.invoices.find((row) => row.id === INV_A)!.status).toBe("PAID");
  });
});
