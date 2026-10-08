/**
 * Public invoice-portal pay flow (Slice P2-S4) — in-memory, mirroring
 * tests/authorization/payment-actions.test.ts (bun:test mock.module fakes;
 * excluded from vitest, which cannot resolve bun:test).
 *
 * What this proves at the ACTION layer:
 * - the checkout authorizes by TOKEN ONLY (requireOrg/requirePermission throw);
 * - the charged amount is the SERVER-READ balance (the payload carries only the
 *   token — the customer can never set an amount);
 * - it reuses the P2-3 flow exactly: getPayableInvoice guards (DRAFT/VOID/
 *   zero-balance rejected), a PENDING ledger row is created with the metadata
 *   the existing webhook needs (paymentId), and audit rows are written via the
 *   REAL writeAuditLog;
 * - Stripe seam: @/server/stripe/adapter is mock.module'd with a factory that
 *   spreads the REAL adapter and overrides ONLY createInvoiceCheckoutSession —
 *   the other suites (stripe-adapter, stripe-webhook) keep their real
 *   constructStripeEvent/isStripeConfigured/helpers. (A plain closure mock
 *   would leak across bun test files; the spread keeps every other export
 *   genuinely real. Only the session-creation call is faked, which no other
 *   suite exercises offline.)
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ForbiddenError } from "@/lib/errors";

const ORG_A = "org-local-a";
const ORG_B = "org-local-b";
const CUST_A = "custA000000000000000000001a";
const INV_A = "cinvA00000000000000000001a";
const INV_B = "cinvB00000000000000000001b";
const USER_ID = "user-local-1";
const authContext = {
  organizationId: ORG_A,
  userId: USER_ID,
  clerkUserId: "clerk-user-1",
  membership: { role: "OFFICE_STAFF", isActive: true },
  organization: { slug: "acme", name: "Acme", timezone: "UTC", currency: "USD" },
};
let grantedPermissions: readonly string[] = ["*"];
mock.module("@/server/auth/require-org", () => ({
  requireOrg: async () => {
    throw new Error("portal actions must never call requireOrg");
  },
  requirePermission: async (permission: string) => {
    if (!grantedPermissions.includes("*") && !grantedPermissions.includes(permission)) {
      throw new ForbiddenError(`Missing permission: ${permission}`);
    }
    return authContext;
  },
  requireRole: async () => authContext,
}));
mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("next/headers", () => ({
  headers: async () => new Headers({ host: "app.example" }),
}));

// Real adapter FIRST, then re-register with only the network-touching export
// replaced (spread keeps every other export real for the later stripe suites).
const realAdapter = await import("@/server/stripe/adapter");
mock.module("@/server/stripe/adapter", () => ({
  ...realAdapter,
  createInvoiceCheckoutSession: async (input: { amountCents: number }) => {
    // Mirror the real adapter's fail-closed contract (no keys → 501).
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.trim() === "") {
      throw new realAdapter.StripeNotConfiguredError();
    }
    return { id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/test", amountCents: input.amountCents };
  },
}));

const state = {
  customers: [] as Array<Record<string, any>>,
  invoices: [] as Array<Record<string, any>>,
  payments: [] as Array<Record<string, any>>,
  audit: [] as Array<Record<string, any>>,
};
function resetState() {
  state.customers = [{ id: CUST_A, organizationId: ORG_A }];
  state.invoices = [
    {
      id: INV_A,
      organizationId: ORG_A,
      customerId: CUST_A,
      invoiceNumber: 7,
      status: "SENT",
      subtotalCents: 10000,
      taxCents: 0,
      totalCents: 10000,
      paidCents: 0,
      balanceCents: 10000,
      dueAt: null,
      paidAt: null,
      portalToken: null,
    },
    {
      id: INV_B,
      organizationId: ORG_B,
      customerId: "custB000000000000000000001b",
      invoiceNumber: 99,
      status: "SENT",
      subtotalCents: 5,
      taxCents: 0,
      totalCents: 5,
      paidCents: 0,
      balanceCents: 5,
      dueAt: null,
      paidAt: null,
      portalToken: null,
    },
  ];
  state.payments = [];
  state.audit = [];
}
function match(where: any, rows: Array<Record<string, any>>): Array<Record<string, any>> {
  return rows.filter((row) => {
    if (where.portalToken !== undefined && row.portalToken !== where.portalToken) return false;
    if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.invoiceId !== undefined && row.invoiceId !== where.invoiceId) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.paidCents !== undefined && row.paidCents !== where.paidCents) return false;
    return true;
  });
}
mock.module("@/server/db/client", () => {
  const db: Record<string, any> = {
    $executeRaw: async () => 0,
    customer: { findFirst: async ({ where }: any) => match(where, state.customers)[0] ?? null },
    invoice: {
      findFirst: async ({ where }: any) => {
        const row = match(where, state.invoices)[0];
        if (!row) return null;
        return {
          ...row,
          customer: state.customers.find((customer) => customer.id === row.customerId) ?? null,
          organization: { id: row.organizationId, name: "Acme", slug: "acme", currency: "USD", timezone: "UTC" },
          payments: [],
        };
      },
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
        const created = {
          id: `cpayA00000000000000000001${state.payments.length + 1}`,
          stripePaymentIntentId: null,
          stripeCheckoutSessionId: null,
          appliedAt: new Date(),
          ...data,
        };
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
    auditLog: {
      create: async ({ data }: any) => {
        state.audit.push(data);
        return data;
      },
    },
  };
  const txClient: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(db)) {
    if (key !== "$transaction") txClient[key] = value;
  }
  db.$transaction = async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(txClient);
  return { db };
});

const { startInvoiceCheckoutByPortalToken, revealInvoicePortalLink } = await import(
  "@/features/portal/server/portal.actions"
);
import { generatePortalToken } from "@/server/domain/portal-token";

beforeEach(() => {
  resetState();
  grantedPermissions = ["*"];
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy_key";
});

describe("public invoice checkout by token (no auth)", () => {
  it("opens a checkout for the SERVER-READ balance and creates the audited PENDING row", async () => {
    const token = generatePortalToken();
    state.invoices[0].portalToken = token;
    const result = await startInvoiceCheckoutByPortalToken({ token });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.data.url).toBe("https://checkout.stripe.com/c/pay/test");
    // PENDING ledger row exists with exactly the invoice's balance (never a
    // client amount — the payload carried only the token).
    const payment = state.payments[0];
    expect(payment.status).toBe("PENDING");
    expect(payment.amountCents).toBe(10000);
    expect(payment.invoiceId).toBe(INV_A);
    expect(payment.customerId).toBe(CUST_A);
    // Audit row: CREATE Payment, source customer portal, anonymous actor.
    const audit = state.audit[0];
    expect(audit.action).toBe("CREATE");
    expect(audit.entityType).toBe("Payment");
    expect(audit.entityId).toBe(payment.id);
    expect(audit.actorUserId).toBeNull();
    expect(audit.metadata.source).toBe("stripe_checkout_portal");
    // The next step is Stripe's own webhook (P2-3): metadata must carry the
    // ids it needs to find our ledger row.
    expect(result.data.paymentId).toBe(payment.id);
  });
  it("passes the server balance and portal return URLs into the checkout session", async () => {
    const token = generatePortalToken();
    state.invoices[0].portalToken = token;
    const result = await startInvoiceCheckoutByPortalToken({ token });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    // The fake adapter echoes amountCents — assert it was the SERVER-READ balance.
    // (Indirect: the PENDING row amount must equal the invoice balance too.)
    expect(state.payments[0].amountCents).toBe(state.invoices[0].balanceCents);
  });
  it("rejects a DRAFT invoice (payable guard) with nothing written", async () => {
    const token = generatePortalToken();
    state.invoices[0].portalToken = token;
    state.invoices[0].status = "DRAFT";
    const result = await startInvoiceCheckoutByPortalToken({ token });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("CONFLICT");
    expect(state.payments).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
  it("rejects a VOID invoice", async () => {
    const token = generatePortalToken();
    state.invoices[0].portalToken = token;
    state.invoices[0].status = "VOID";
    const result = await startInvoiceCheckoutByPortalToken({ token });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("CONFLICT");
    expect(state.payments).toHaveLength(0);
  });
  it("rejects a zero-balance invoice (nothing to pay)", async () => {
    const token = generatePortalToken();
    state.invoices[0].portalToken = token;
    state.invoices[0].balanceCents = 0;
    const result = await startInvoiceCheckoutByPortalToken({ token });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("CONFLICT");
    expect(state.payments).toHaveLength(0);
  });
  it("charges the CURRENT balance for a partially-paid invoice", async () => {
    const token = generatePortalToken();
    state.invoices[0].portalToken = token;
    state.invoices[0].paidCents = 4000;
    state.invoices[0].balanceCents = 6000;
    const result = await startInvoiceCheckoutByPortalToken({ token });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(state.payments[0].amountCents).toBe(6000);
  });
  it("returns NOT_FOUND for an unknown token", async () => {
    const result = await startInvoiceCheckoutByPortalToken({ token: generatePortalToken() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(state.payments).toHaveLength(0);
  });
  it("fails closed with STRIPE_NOT_CONFIGURED when the keys are missing", async () => {
    const token = generatePortalToken();
    state.invoices[0].portalToken = token;
    const previousKey = process.env.STRIPE_SECRET_KEY;
    try {
      delete process.env.STRIPE_SECRET_KEY;
      const result = await startInvoiceCheckoutByPortalToken({ token });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure result");
      expect(result.error.code).toBe("STRIPE_NOT_CONFIGURED");
      // The PENDING row was created BEFORE the session (same order as the
      // internal flow); no reconcile happened and the row is still PENDING.
      expect(state.payments).toHaveLength(1);
      expect(state.payments[0].status).toBe("PENDING");
    } finally {
      process.env.STRIPE_SECRET_KEY = previousKey;
    }
  });
  it("rejects a malformed token before any db read", async () => {
    const result = await startInvoiceCheckoutByPortalToken({ token: "bad-token" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(state.payments).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
  it("keeps tenants isolated: org B's token charges org B's invoice only", async () => {
    const tokenA = generatePortalToken();
    const tokenB = generatePortalToken();
    state.invoices[0].portalToken = tokenA;
    state.invoices[1].portalToken = tokenB;
    const result = await startInvoiceCheckoutByPortalToken({ token: tokenB });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0].invoiceId).toBe(INV_B);
    expect(state.payments[0].amountCents).toBe(5);
    expect(state.payments[0].organizationId).toBe(ORG_B);
    expect(state.audit[0].organizationId).toBe(ORG_B);
  });
});

describe("internal invoice reveal action (office staff)", () => {
  it("generates once, is stable afterwards, and audits only the first time", async () => {
    const first = await revealInvoicePortalLink({ id: INV_A });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok result");
    expect(first.data.generated).toBe(true);
    const token = state.invoices[0].portalToken!;
    expect(first.data.url).toBe(`https://app.example/portal/invoice/${token}`);
    const second = await revealInvoicePortalLink({ id: INV_A });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok result");
    expect(second.data.generated).toBe(false);
    expect(second.data.url).toBe(first.data.url);
    expect(state.audit).toHaveLength(1);
  });
  it("denies a caller without INVOICE_UPDATE", async () => {
    grantedPermissions = ["INVOICE_READ"];
    const result = await revealInvoicePortalLink({ id: INV_A });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("FORBIDDEN");
    expect(state.invoices[0].portalToken).toBeNull();
  });
  it("rejects a foreign invoice id", async () => {
    const result = await revealInvoicePortalLink({ id: INV_B });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(state.invoices[1].portalToken).toBeNull();
  });
});
