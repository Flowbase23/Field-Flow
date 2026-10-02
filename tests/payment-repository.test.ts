/**
 * Payment repository guard tests (Phase 2 Slice P2-3) use a small Prisma-shaped
 * fake at the repo seam — same discipline as invoice-repository.test.ts. The
 * fake has NO $transaction, so the repo exercises its direct in-transaction
 * code paths (the client-mode wrap is exercised by the action/webhook suites).
 *
 * Covered money rules (payment.repo.ts header §3):
 * - integer cents only, amount > 0, server-authoritative recompute;
 * - DRAFT/VOID invoices reject payments before any write;
 * - overpayment (balance < 0) is rejected;
 * - SENT → PARTIALLY_PAID → PAID reconcile + reversal unwind (paidAt stamped
 *   on PAID, cleared on full reversal);
 * - optimistic-guard ConflictError (count 0) and per-org advisory lock;
 * - tenant isolation on every read and write; customer override verified;
 * - immutable ledger: no generic update path on the repo, transitions only.
 */
import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { createPaymentRepo, paymentListWhere } from "@/server/repositories/payment.repo";

const ORG_A = "org-a";
const ORG_B = "org-b";
const NOW = new Date("2026-10-02T15:00:00.000Z");
const LATER = new Date("2026-10-02T16:00:00.000Z");

type Row = Record<string, any>;
function makePrisma() {
  const customers = [
    { id: "customer-a", organizationId: ORG_A },
    { id: "customer-b", organizationId: ORG_B },
  ];
  const invoices: Row[] = [
    { id: "inv-a1", organizationId: ORG_A, invoiceNumber: 4, customerId: "customer-a", status: "SENT", totalCents: 10800, paidCents: 0, balanceCents: 10800, paidAt: null },
    { id: "inv-a2", organizationId: ORG_A, invoiceNumber: 7, customerId: "customer-a", status: "PARTIALLY_PAID", totalCents: 5000, paidCents: 2000, balanceCents: 3000, paidAt: null },
    { id: "inv-a3", organizationId: ORG_A, invoiceNumber: 9, customerId: "customer-a", status: "PAID", totalCents: 2000, paidCents: 2000, balanceCents: 0, paidAt: new Date("2026-09-30T10:00:00.000Z") },
    { id: "inv-a4", organizationId: ORG_A, invoiceNumber: 10, customerId: "customer-a", status: "DRAFT", totalCents: 900, paidCents: 0, balanceCents: 900, paidAt: null },
    { id: "inv-a5", organizationId: ORG_A, invoiceNumber: 11, customerId: "customer-a", status: "VOID", totalCents: 900, paidCents: 0, balanceCents: 900, paidAt: null },
    { id: "inv-b1", organizationId: ORG_B, invoiceNumber: 99, customerId: "customer-b", status: "SENT", totalCents: 1, paidCents: 0, balanceCents: 1, paidAt: null },
  ];
  const payments: Row[] = [];
  let paymentSeq = 0;
  const locks = vi.fn(async () => 0);
  function matchInvoice(where: any): Row[] {
    return invoices.filter((row) => {
      if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
      if (where.id !== undefined && row.id !== where.id) return false;
      if (where.status !== undefined && row.status !== where.status) return false;
      if (where.paidCents !== undefined && row.paidCents !== where.paidCents) return false;
      return true;
    });
  }
  function matchPayment(where: any): Row[] {
    return payments.filter((row) => {
      if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
      if (where.id !== undefined && row.id !== where.id) return false;
      if (where.invoiceId !== undefined && row.invoiceId !== where.invoiceId) return false;
      if (where.customerId !== undefined && row.customerId !== where.customerId) return false;
      if (where.status !== undefined && row.status !== where.status) return false;
      if (where.method !== undefined && row.method !== where.method) return false;
      if (where.stripeCheckoutSessionId !== undefined && row.stripeCheckoutSessionId !== where.stripeCheckoutSessionId) return false;
      if (where.stripePaymentIntentId !== undefined && row.stripePaymentIntentId !== where.stripePaymentIntentId) return false;
      return true;
    });
  }
  const prisma = {
    $executeRaw: locks,
    $transaction: undefined as unknown,
    customer: {
      findFirst: vi.fn(async ({ where }: any) => {
        const row = customers.find((c) => c.id === where.id && c.organizationId === where.organizationId);
        return row ? { id: row.id } : null;
      }),
    },
    invoice: {
      findFirst: vi.fn(async ({ where }: any) => matchInvoice(where)[0] ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = matchInvoice(where)[0];
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    payment: {
      findFirst: vi.fn(async ({ where }: any) => matchPayment(where)[0] ?? null),
      findMany: vi.fn(async ({ where, take = 25, skip = 0 }: any) =>
        matchPayment(where).slice(skip, skip + take).map((row) => ({
          ...row,
          invoice: { ...invoices.find((invoice) => invoice.id === row.invoiceId) },
          customer: row.customerId ? { ...customers.find((c) => c.id === row.customerId) } : null,
        })),
      ),
      count: vi.fn(async ({ where }: any) => matchPayment(where).length),
      create: vi.fn(async ({ data }: any) => {
        const created = {
          id: `pay-${(paymentSeq += 1)}`,
          stripePaymentIntentId: null,
          stripeCheckoutSessionId: null,
          createdAt: NOW,
          updatedAt: NOW,
          ...data,
        };
        payments.push(created);
        return created;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = matchPayment(where)[0];
        if (!row) return { count: 0 };
        Object.assign(row, data, { updatedAt: LATER });
        return { count: 1 };
      }),
    },
  };
  function seedPayment(overrides: Partial<Row> & { status: string; invoiceId: string; amountCents: number }): Row {
    const created = {
      id: `pay-${(paymentSeq += 1)}`,
      organizationId: ORG_A,
      customerId: "customer-a",
      method: "CASH",
      notes: null,
      stripePaymentIntentId: null,
      stripeCheckoutSessionId: null,
      appliedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
    payments.push(created);
    return created;
  }
  return { prisma, locks, invoices, payments, seedPayment };
}

describe("Payment money validation (integer cents, server-authoritative)", () => {
  it.each([
    ["zero", 0],
    ["negative", -5000],
    ["fractional", 12.5],
    ["not a number", Number.NaN],
  ])("rejects a %s amount before any write", async (_label, amountCents) => {
    const { prisma, payments } = makePrisma();
    await expect(
      createPaymentRepo(prisma as never, ORG_A).record({ invoiceId: "inv-a1", amountCents: amountCents as number, method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(payments).toHaveLength(0);
  });
  it("rejects amounts beyond the safe-integer range", async () => {
    const { prisma } = makePrisma();
    await expect(
      createPaymentRepo(prisma as never, ORG_A).record({ invoiceId: "inv-a1", amountCents: Number.MAX_SAFE_INTEGER + 1, method: "CASH" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("Reconcile rules (apply)", () => {
  it("applies an exact-balance payment: SENT → PAID, balance 0, paidAt stamped, ledger row SUCCEEDED", async () => {
    const { prisma, invoices, payments, locks } = makePrisma();
    const result = await createPaymentRepo(prisma as never, ORG_A).record({ invoiceId: "inv-a1", amountCents: 10800, method: "CHECK" }, { now: NOW });
    expect(result.payment.status).toBe("SUCCEEDED");
    expect(result.payment.customerId).toBe("customer-a"); // defaults to the invoice's customer
    expect(result.invoiceAfter!.status).toBe("PAID");
    expect(result.invoiceAfter!.paidCents).toBe(10800);
    expect(result.invoiceAfter!.balanceCents).toBe(0);
    expect(result.invoiceAfter!.paidAt).toEqual(NOW);
    expect(payments).toHaveLength(1);
    expect(locks).toHaveBeenCalledTimes(1); // per-org advisory lock before the money write
  });
  it("applies a partial payment: SENT → PARTIALLY_PAID with recomputed balance", async () => {
    const { prisma, invoices } = makePrisma();
    const result = await createPaymentRepo(prisma as never, ORG_A).record({ invoiceId: "inv-a1", amountCents: 800, method: "CASH" }, { now: NOW });
    expect(result.invoiceAfter!.status).toBe("PARTIALLY_PAID");
    expect(result.invoiceAfter!.paidCents).toBe(800);
    expect(result.invoiceAfter!.balanceCents).toBe(10000);
    expect(result.invoiceAfter!.paidAt).toBeNull(); // untouched — never reached PAID
    expect(invoices.find((invoice) => invoice.id === "inv-a1")!.paidAt).toBeNull();
  });
  it("rejects further money once an invoice is fully paid (balance guard)", async () => {
    const { prisma, invoices } = makePrisma();
    const repo = createPaymentRepo(prisma as never, ORG_A);
    const first = await repo.record({ invoiceId: "inv-a2", amountCents: 3000, method: "CASH" }, { now: NOW });
    expect(first.invoiceAfter!.status).toBe("PAID"); // 2000 + 3000 = total 5000
    await expect(repo.record({ invoiceId: "inv-a2", amountCents: 100, method: "CASH" }, { now: LATER })).rejects.toBeInstanceOf(ConflictError);
    expect(invoices.find((invoice) => invoice.id === "inv-a2")!.paidCents).toBe(5000);
    expect(invoices.find((invoice) => invoice.id === "inv-a2")!.status).toBe("PAID");
  });
  it("rejects overpayment (balance would go below zero) and writes nothing", async () => {
    const { prisma, invoices, payments } = makePrisma();
    await expect(
      createPaymentRepo(prisma as never, ORG_A).record({ invoiceId: "inv-a1", amountCents: 10801, method: "CASH" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(invoices.find((invoice) => invoice.id === "inv-a1")!.paidCents).toBe(0);
    expect(payments).toHaveLength(0);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
  it("rejects a partial overpayment of a PARTIALLY_PAID invoice", async () => {
    const { prisma } = makePrisma();
    await expect(
      createPaymentRepo(prisma as never, ORG_A).record({ invoiceId: "inv-a2", amountCents: 3001, method: "CASH" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
  it("rejects payments on DRAFT invoices with a send-first message", async () => {
    const { prisma, payments } = makePrisma();
    await expect(
      createPaymentRepo(prisma as never, ORG_A).record({ invoiceId: "inv-a4", amountCents: 100, method: "CASH" }),
    ).rejects.toThrow(/draft invoice cannot receive payments/i);
    expect(payments).toHaveLength(0);
  });
  it("rejects payments on VOID invoices", async () => {
    const { prisma, payments } = makePrisma();
    await expect(
      createPaymentRepo(prisma as never, ORG_A).record({ invoiceId: "inv-a5", amountCents: 100, method: "CASH" }),
    ).rejects.toThrow(/voided invoice cannot receive payments/i);
    expect(payments).toHaveLength(0);
  });
  it("fails closed when the optimistic guard observes a concurrent invoice change (count 0)", async () => {
    const { prisma, payments } = makePrisma();
    (prisma.invoice.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
    await expect(
      createPaymentRepo(prisma as never, ORG_A).record({ invoiceId: "inv-a1", amountCents: 1000, method: "CASH" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(payments).toHaveLength(0);
  });
  it("verifies an explicit customer override against the tenant", async () => {
    const { prisma, payments } = makePrisma();
    await expect(
      createPaymentRepo(prisma as never, ORG_A).record({ invoiceId: "inv-a1", amountCents: 1000, method: "CASH", customerId: "customer-b" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(payments).toHaveLength(0);
  });
});

describe("Reconcile rules (reverse)", () => {
  it("voids a SUCCEEDED payment: the invoice unwinds fully (PAID → SENT, paidAt cleared)", async () => {
    const { prisma, invoices, seedPayment } = makePrisma();
    const payment = seedPayment({ status: "SUCCEEDED", invoiceId: "inv-a3", amountCents: 2000 });
    const result = await createPaymentRepo(prisma as never, ORG_A).void(payment.id, { now: LATER });
    expect(result.payment.status).toBe("VOIDED");
    expect(result.invoiceAfter!.status).toBe("SENT");
    expect(result.invoiceAfter!.paidCents).toBe(0);
    expect(result.invoiceAfter!.balanceCents).toBe(2000);
    expect(result.invoiceAfter!.paidAt).toBeNull();
    expect(invoices.find((invoice) => invoice.id === "inv-a3")!.paidCents).toBe(0);
  });
  it("voids a SUCCEEDED payment on a partially-paid invoice: PAID → PARTIALLY_PAID stays truthful", async () => {
    const { prisma, seedPayment } = makePrisma();
    const payment = seedPayment({ status: "SUCCEEDED", invoiceId: "inv-a2", amountCents: 1000 });
    const result = await createPaymentRepo(prisma as never, ORG_A).void(payment.id);
    expect(result.invoiceAfter!.status).toBe("PARTIALLY_PAID");
    expect(result.invoiceAfter!.paidCents).toBe(1000);
    expect(result.invoiceAfter!.balanceCents).toBe(4000);
  });
  it("refunds a SUCCEEDED payment: REFUNDED status + reversed reconcile", async () => {
    const { prisma, seedPayment } = makePrisma();
    const payment = seedPayment({ status: "SUCCEEDED", invoiceId: "inv-a3", amountCents: 2000 });
    const result = await createPaymentRepo(prisma as never, ORG_A).refund(payment.id, { now: LATER });
    expect(result.payment.status).toBe("REFUNDED");
    expect(result.invoiceAfter!.paidCents).toBe(0);
    expect(result.invoiceAfter!.balanceCents).toBe(2000);
    expect(result.invoiceAfter!.status).toBe("SENT");
    expect(result.invoiceAfter!.paidAt).toBeNull();
  });
  it("voids a PENDING payment without touching the invoice (no money moved)", async () => {
    const { prisma, seedPayment } = makePrisma();
    const payment = seedPayment({ status: "PENDING", invoiceId: "inv-a1", amountCents: 5000 });
    const result = await createPaymentRepo(prisma as never, ORG_A).void(payment.id);
    expect(result.payment.status).toBe("VOIDED");
    expect(result.invoiceBefore).toBeNull();
    expect(result.invoiceAfter).toBeNull();
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
  it("refuses to reverse below the invoice's recorded paid amount", async () => {
    const { prisma, invoices, seedPayment } = makePrisma();
    const payment = seedPayment({ status: "SUCCEEDED", invoiceId: "inv-a3", amountCents: 2000 });
    // Simulate out-of-band drift: someone already wound the invoice back.
    invoices.find((invoice) => invoice.id === "inv-a3")!.paidCents = 500;
    invoices.find((invoice) => invoice.id === "inv-a3")!.status = "PARTIALLY_PAID";
    invoices.find((invoice) => invoice.id === "inv-a3")!.balanceCents = 1500;
    await expect(createPaymentRepo(prisma as never, ORG_A).void(payment.id)).rejects.toThrow(/exceed the invoice's recorded paid amount/i);
  });
  it("enforces the payment transition map on corrections", async () => {
    const { prisma, seedPayment } = makePrisma();
    const pending = seedPayment({ status: "PENDING", invoiceId: "inv-a1", amountCents: 1000 });
    await expect(createPaymentRepo(prisma as never, ORG_A).refund(pending.id)).rejects.toBeInstanceOf(ConflictError);
    const failed = seedPayment({ status: "FAILED", invoiceId: "inv-a1", amountCents: 1000 });
    await expect(createPaymentRepo(prisma as never, ORG_A).void(failed.id)).rejects.toBeInstanceOf(ConflictError);
    const refunded = seedPayment({ status: "REFUNDED", invoiceId: "inv-a1", amountCents: 1000 });
    await expect(createPaymentRepo(prisma as never, ORG_A).void(refunded.id)).rejects.toBeInstanceOf(ConflictError);
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });
  it("stamps the Stripe intent id only on the succeeded transition", async () => {
    const { prisma, seedPayment } = makePrisma();
    const payment = seedPayment({ status: "PENDING", invoiceId: "inv-a1", amountCents: 1000, stripeCheckoutSessionId: "cs_test_1" });
    const result = await createPaymentRepo(prisma as never, ORG_A).markSucceeded(payment.id, { now: LATER, stripePaymentIntentId: "pi_test_1" });
    expect(result.payment.status).toBe("SUCCEEDED");
    expect(result.payment.stripePaymentIntentId).toBe("pi_test_1");
    expect(result.invoiceAfter!.paidCents).toBe(1000);
  });
  it("is idempotent when a retried webhook confirms an already-SUCCEEDED payment", async () => {
    const { prisma, seedPayment } = makePrisma();
    const payment = seedPayment({ status: "SUCCEEDED", invoiceId: "inv-a3", amountCents: 2000 });
    const result = await createPaymentRepo(prisma as never, ORG_A).markSucceeded(payment.id);
    expect(result.payment.id).toBe(payment.id);
    expect(result.invoiceBefore).toBeNull();
    expect(result.invoiceAfter).toBeNull();
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
  it("moves PENDING → FAILED idempotently without touching the invoice", async () => {
    const { prisma, seedPayment } = makePrisma();
    const payment = seedPayment({ status: "PENDING", invoiceId: "inv-a1", amountCents: 1000 });
    const failed = await createPaymentRepo(prisma as never, ORG_A).markFailed(payment.id);
    expect(failed.status).toBe("FAILED");
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    const again = await createPaymentRepo(prisma as never, ORG_A).markFailed(payment.id);
    expect(again.status).toBe("FAILED");
  });
});

describe("Stripe checkout primitives", () => {
  it("createPending opens a PENDING ledger row with the checkout ids and no reconcile", async () => {
    const { prisma, invoices, payments } = makePrisma();
    const created = await createPaymentRepo(prisma as never, ORG_A).createPending({
      invoiceId: "inv-a1",
      amountCents: 10800,
      method: "CARD",
      stripeCheckoutSessionId: "cs_test_1",
    });
    expect(created.status).toBe("PENDING");
    expect(created.stripeCheckoutSessionId).toBe("cs_test_1");
    expect(payments).toHaveLength(1);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled(); // no money moved
    expect(invoices.find((invoice) => invoice.id === "inv-a1")!.paidCents).toBe(0);
  });
  it("createPending validates the amount and tenant before creating", async () => {
    const { prisma, payments } = makePrisma();
    await expect(createPaymentRepo(prisma as never, ORG_A).createPending({ invoiceId: "inv-a1", amountCents: 0, method: "CARD" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPaymentRepo(prisma as never, ORG_A).createPending({ invoiceId: "inv-b1", amountCents: 1, method: "CARD" })).rejects.toBeInstanceOf(NotFoundError);
    expect(payments).toHaveLength(0);
  });
  it("getPayableInvoice returns a payable invoice and rejects drafts/voids/settled ones", async () => {
    const { prisma } = makePrisma();
    const repo = createPaymentRepo(prisma as never, ORG_A);
    expect((await repo.getPayableInvoice("inv-a1")).id).toBe("inv-a1");
    await expect(repo.getPayableInvoice("inv-a4")).rejects.toThrow(/draft/i);
    await expect(repo.getPayableInvoice("inv-a5")).rejects.toThrow(/voided/i);
    await expect(repo.getPayableInvoice("inv-a3")).rejects.toThrow(/no outstanding balance/i);
    await expect(repo.getPayableInvoice("inv-b1")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("Tenant isolation + list scoping", () => {
  it("rejects cross-tenant invoice ids on every write path", async () => {
    const { prisma, payments } = makePrisma();
    const repo = createPaymentRepo(prisma as never, ORG_A);
    await expect(repo.record({ invoiceId: "inv-b1", amountCents: 1, method: "CASH" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.markSucceeded("pay-foreign")).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.void("pay-foreign")).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.refund("pay-foreign")).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.markFailed("pay-foreign")).rejects.toBeInstanceOf(NotFoundError);
    expect(payments).toHaveLength(0);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
  it("hides cross-tenant rows on reads", async () => {
    const { prisma, seedPayment } = makePrisma();
    seedPayment({ status: "SUCCEEDED", invoiceId: "inv-a1", amountCents: 100 });
    seedPayment({ status: "SUCCEEDED", invoiceId: "inv-b1", amountCents: 1, organizationId: ORG_B });
    const repo = createPaymentRepo(prisma as never, ORG_A);
    expect(await repo.getById("pay-2")).toBeNull(); // org-b's row is invisible
    expect(await repo.getDetail("pay-2")).toBeNull();
    expect(await repo.list()).toHaveLength(1);
    expect(await repo.count()).toBe(1);
  });
  it("scopes listForInvoice to the tenant and the invoice", async () => {
    const { prisma, seedPayment } = makePrisma();
    seedPayment({ status: "SUCCEEDED", invoiceId: "inv-a1", amountCents: 100 });
    seedPayment({ status: "SUCCEEDED", invoiceId: "inv-a2", amountCents: 200 });
    const rows = await createPaymentRepo(prisma as never, ORG_A).listForInvoice("inv-a1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invoiceId).toBe("inv-a1");
  });
  it("builds the shared tenant-scoped where predicate", () => {
    expect(paymentListWhere(ORG_A, { status: "SUCCEEDED", method: "CASH", invoiceId: "inv-a1", customerId: "customer-a" })).toEqual({
      organizationId: ORG_A,
      status: "SUCCEEDED",
      method: "CASH",
      invoiceId: "inv-a1",
      customerId: "customer-a",
    });
    expect(paymentListWhere(ORG_A, { appliedFrom: NOW, appliedTo: LATER })).toEqual({
      organizationId: ORG_A,
      appliedAt: { gte: NOW, lte: LATER },
    });
  });
  it("clamps page size and applies pagination", async () => {
    const { prisma, seedPayment } = makePrisma();
    for (let i = 0; i < 3; i += 1) seedPayment({ status: "SUCCEEDED", invoiceId: "inv-a1", amountCents: 100 + i });
    const repo = createPaymentRepo(prisma as never, ORG_A);
    const page = await repo.list({ page: 2, pageSize: 2 });
    expect(page).toHaveLength(1);
    expect(prisma.payment.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 2, skip: 2 }));
  });
});

describe("Immutable ledger (no generic update path)", () => {
  it("exposes only create/transition/list primitives — no update or delete", () => {
    const repo = createPaymentRepo({} as never, ORG_A) as unknown as Record<string, unknown>;
    const forbidden = Object.keys(repo).filter((key) => /^(update|updateMany|delete|deleteMany|upsert)$/i.test(key));
    expect(forbidden).toEqual([]);
  });
  it("never rewrites a payment's amount: corrections are transitions, not edits", async () => {
    const { prisma, invoices, seedPayment } = makePrisma();
    // The ledger is truthful: this SUCCEEDED payment's money IS on the invoice.
    invoices.find((invoice) => invoice.id === "inv-a1")!.paidCents = 1000;
    invoices.find((invoice) => invoice.id === "inv-a1")!.balanceCents = 9800;
    invoices.find((invoice) => invoice.id === "inv-a1")!.status = "PARTIALLY_PAID";
    const payment = seedPayment({ status: "SUCCEEDED", invoiceId: "inv-a1", amountCents: 1000 });
    const result = await createPaymentRepo(prisma as never, ORG_A).refund(payment.id);
    expect(result.payment.amountCents).toBe(1000); // the row keeps its amount forever
    expect(result.payment.status).toBe("REFUNDED");
    expect(result.invoiceAfter!.status).toBe("SENT"); // fully reversed
  });
});
