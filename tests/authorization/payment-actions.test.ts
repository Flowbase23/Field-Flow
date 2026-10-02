/**
 * Action-level permission gates and cross-tenant rejection for the payment
 * server actions (src/features/payments/server/payment.actions.ts).
 *
 * IN-MEMORY ONLY, mirroring tests/authorization/invoice-actions.test.ts: the
 * requirePermission seam and the shared Prisma db singleton are replaced with
 * bun:test `mock.module()` fakes (bun's runner ignores vi.mock, and vitest
 * cannot resolve bun:test — this file is excluded in vitest.config.ts and runs
 * under `bun test`, the project gate).
 *
 * What this proves at the ACTION layer (not just the repo layer):
 * - every payment action re-gates on its PAYMENT_* permission (read, create,
 *   void, refund are separate grants);
 * - a cross-tenant invoice/payment id returns a user-safe `ok: false`
 *   NOT_FOUND result and writes nothing (no ledger row, no reconcile, no audit
 *   row) even though the caller is an authenticated member of ANOTHER org;
 * - every money write lands its audit rows (CREATE/STATUS_CHANGED Payment +
 *   UPDATE Invoice reconcile) in the same transaction.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ForbiddenError } from "@/lib/errors";

const ORG_A = "org-local-a";
// Fixture ids are cuid-shaped: payment payloads are validated by zod's cuid.
const CUST_A = "custA000000000000000000001a";
const INV_A = "cinvA00000000000000000001a";
const INV_B = "cinvB00000000000000000001b";
const USER_ID = "user-local-1";
/** The auth context the mocked requirePermission resolves to (a member of ORG_A). */
const authContext = {
  organizationId: ORG_A,
  userId: USER_ID,
  clerkUserId: "clerk-user-1",
  membership: { role: "OWNER", isActive: true },
  organization: { slug: "acme", name: "Acme", timezone: "UTC", currency: "USD" },
};

/** Permissions the fake requirePermission will grant ("*" = owner with all). */
let grantedPermissions: readonly string[] = ["*"];
mock.module("@/server/auth/require-org", () => ({
  requireOrg: async () => authContext,
  requirePermission: async (permission: string) => {
    if (!grantedPermissions.includes("*") && !grantedPermissions.includes(permission)) {
      throw new ForbiddenError(`Missing permission: ${permission}`);
    }
    return authContext;
  },
  requireRole: async () => authContext,
}));
mock.module("next/cache", () => ({
  revalidatePath: () => {},
}));
// NOTE: @/server/audit is deliberately NOT mocked here (mirroring the
// invoice/estimate action suites): bun's mock.module registrations leak across
// test files in a full `bun test` run, and a closure-based audit mock would
// capture THIS file's state array for other suites. The REAL writeAuditLog
// routes through the db fake's auditLog.create below instead.

/** In-memory Customer/Invoice/Payment tables, scoped by org (audit captured above). */
const state = {
  customers: [] as Array<Record<string, any>>,
  invoices: [] as Array<Record<string, any>>,
  payments: [] as Array<Record<string, any>>,
  audit: [] as Array<Record<string, any>>,
};
function resetState() {
  state.customers = [
    { id: CUST_A, organizationId: ORG_A },
  ];
  state.invoices = [
    { id: INV_A, organizationId: ORG_A, invoiceNumber: 4, customerId: CUST_A, status: "SENT", totalCents: 10000, paidCents: 0, balanceCents: 10000, paidAt: null },
    { id: INV_B, organizationId: "org-foreign", invoiceNumber: 99, customerId: "custB000000000000000000001b", status: "SENT", totalCents: 1, paidCents: 0, balanceCents: 1, paidAt: null },
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
    return true;
  });
}
mock.module("@/server/db/client", () => {
  const db: Record<string, any> = {
    // pg advisory lock (payment reconcile serialization) — recorded, no result set.
    $executeRaw: async () => 0,
    customer: {
      findFirst: async ({ where }: any) => match(where, state.customers)[0] ?? null,
    },
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
      findMany: async ({ where, take = 25, skip = 0 }: any) =>
        match(where, state.payments).slice(skip, skip + take).map((row) => ({
          ...row,
          invoice: { ...state.invoices.find((invoice) => invoice.id === row.invoiceId) },
          customer: row.customerId ? { ...state.customers.find((customer) => customer.id === row.customerId) } : null,
        })),
      create: async ({ data }: any) => {
        const created = { id: `cpayA00000000000000000001${state.payments.length + 1}`, stripePaymentIntentId: null, stripeCheckoutSessionId: null, ...data };
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

// Import the module under test AFTER the mocks are registered.
const { getPayment, getPayments, recordPayment, voidPayment, refundPayment } = await import("@/features/payments/server/payment.actions");
const RECORD = { invoiceId: INV_A, customerId: null, amountCents: 4000, method: "CASH", notes: null };

beforeEach(() => {
  resetState();
  grantedPermissions = ["*"];
});

describe("recordPayment — permission gate + cross-tenant rejection", () => {
  it("refuses without PAYMENT_CREATE even when authenticated in the org", async () => {
    grantedPermissions = ["PAYMENT_READ"];
    const result = await recordPayment(RECORD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(state.payments).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
  it("rejects a cross-tenant invoice id with a user-safe NOT_FOUND and no writes", async () => {
    const result = await recordPayment({ ...RECORD, invoiceId: INV_B });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    expect(state.payments).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });
  it("records in-tenant: ledger row + reconciled invoice + both audit rows in one transaction", async () => {
    const result = await recordPayment(RECORD);
    expect(result.ok).toBe(true);
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0]!.status).toBe("SUCCEEDED");
    expect(state.payments[0]!.amountCents).toBe(4000);
    expect(state.invoices.find((invoice) => invoice.id === INV_A)!.paidCents).toBe(4000);
    expect(state.invoices.find((invoice) => invoice.id === INV_A)!.status).toBe("PARTIALLY_PAID");
    expect(state.audit.some((row) => row.entityType === "Payment" && row.action === "CREATE")).toBe(true);
    expect(state.audit.some((row) => row.entityType === "Invoice" && row.action === "UPDATE")).toBe(true);
  });
});

describe("voidPayment / refundPayment — permission gates + reversals", () => {
  it("refuses void without PAYMENT_VOID", async () => {
    const seeded = await recordPayment(RECORD);
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.message}`);
    grantedPermissions = ["PAYMENT_READ", "PAYMENT_CREATE"];
    const result = await voidPayment({ id: seeded.data.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(state.payments[0]!.status).toBe("SUCCEEDED");
  });
  it("refunds a SUCCEEDED payment with PAYMENT_REFUND and unwinds the invoice", async () => {
    const seeded = await recordPayment(RECORD);
    if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.message}`);
    grantedPermissions = ["PAYMENT_REFUND"];
    const result = await refundPayment({ id: seeded.data.id });
    expect(result.ok).toBe(true);
    expect(state.payments[0]!.status).toBe("REFUNDED");
    expect(state.invoices.find((invoice) => invoice.id === INV_A)!.paidCents).toBe(0);
    expect(state.invoices.find((invoice) => invoice.id === INV_A)!.status).toBe("SENT");
    expect(state.audit.some((row) => row.entityType === "Payment" && row.action === "STATUS_CHANGED")).toBe(true);
  });
  it("rejects a cross-tenant payment id with NOT_FOUND and writes nothing", async () => {
    const result = await voidPayment({ id: "cpayB00000000000000000001b" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    expect(state.audit).toHaveLength(0);
  });
});

describe("reads — PAYMENT_READ gate + tenant scoping", () => {
  it("refuses getPayment without PAYMENT_READ", async () => {
    grantedPermissions = ["JOB_READ"];
    const result = await getPayment({ id: "cpayA00000000000000000001a" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });
  it("hides a cross-tenant payment from getPayments (ledger is org-local)", async () => {
    state.payments.push({
      id: "cpayB00000000000000000001b",
      organizationId: "org-foreign",
      invoiceId: INV_B,
      customerId: "custB000000000000000000001b",
      amountCents: 1,
      method: "CASH",
      status: "SUCCEEDED",
      notes: null,
      stripePaymentIntentId: null,
      stripeCheckoutSessionId: null,
      appliedAt: new Date(),
    });
    const result = await getPayments({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(0);
  });
});
