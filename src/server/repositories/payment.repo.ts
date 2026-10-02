/**
 * Tenant-scoped Payment repository. Every query carries the organizationId
 * predicate; the linked invoice (compound FK target) and the optional customer
 * are tenant-verified before any write. There is NO generic update: payments
 * are immutable ledger entries — the only writes are the create/transition
 * paths below, and every money movement reconciles the invoice in the SAME
 * transaction.
 *
 * Money rules (design §3 — integer cents, server-authoritative):
 * - `amountCents` must be > 0 (validated again here; the client never sets it
 *   through an update path because no update path exists).
 * - Recording/confirming a payment increments `Invoice.paidCents` by the
 *   amount; a reversal (VOIDED/REFUNDED of a SUCCEEDED payment) decrements it.
 *   `balanceCents = totalCents − paidCents` is recomputed here, never accepted
 *   from the browser, and a payment that would drive the balance below zero
 *   (overpayment) is rejected.
 * - Invoice status follows the money via invoiceStatusAfterPayment()
 *   (SENT/PARTIALLY_PAID → PAID|PARTIALLY_PAID; reversals unwind PAID) —
 *   DRAFT/VOID invoices are rejected before any write.
 * - Writes use the same optimistic-guard discipline as invoices: guarded
 *   `updateMany` on (id, organizationId, observedStatus, observedPaidCents);
 *   count 0 → ConflictError, never a silent overwrite. The per-org advisory
 *   lock serializes concurrent recorders (manual entry vs Stripe webhook);
 *   it uses $executeRaw, NOT $queryRaw: the lock returns `void` and $queryRaw
 *   fails to deserialize a void column against live Postgres (commit ff04182).
 */
import {
  Prisma,
  type Customer,
  type Invoice,
  type InvoiceStatus,
  type Payment,
  type PaymentMethod,
  type PaymentStatus,
  type PrismaClient,
} from "@prisma/client";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { applyPaymentStatusTransition } from "@/server/domain/payment-status";
import {
  canInvoiceReceivePayment,
  invoiceStatusAfterPayment,
  paidAtForPaymentTransition,
} from "@/server/domain/invoice-payment-status";

type Client = Prisma.TransactionClient | PrismaClient;

export interface PaymentRecordData {
  invoiceId: string;
  /** Optional customer override; defaults to the invoice's customer. */
  customerId?: string | null;
  amountCents: number;
  method: PaymentMethod;
  notes?: string | null;
}

export interface PaymentListParams {
  status?: PaymentStatus;
  method?: PaymentMethod;
  invoiceId?: string;
  customerId?: string;
  appliedFrom?: Date;
  appliedTo?: Date;
  page?: number;
  pageSize?: number;
}

export interface PaymentListItem extends Payment {
  invoice: Pick<Invoice, "id" | "invoiceNumber" | "status" | "totalCents" | "paidCents" | "balanceCents">;
  /** Included on list rows too, so the ledger can show the payer. */
  customer: Pick<Customer, "id" | "firstName" | "lastName" | "companyName"> | null;
}
export type PaymentDetail = PaymentListItem;

/** Result of a money-moving payment write: the payment + the invoice reconcile. */
export interface PaymentMutationResult {
  payment: Payment;
  /** Null when no reconcile happened (e.g. voiding a PENDING payment). */
  invoiceBefore: Invoice | null;
  invoiceAfter: Invoice | null;
}

export interface PaymentRepo {
  list(params?: PaymentListParams): Promise<PaymentListItem[]>;
  count(params?: Omit<PaymentListParams, "page" | "pageSize">): Promise<number>;
  getById(id: string): Promise<Payment | null>;
  getDetail(id: string): Promise<PaymentDetail | null>;
  /** Payment history for an invoice detail page (tenant-scoped). */
  listForInvoice(invoiceId: string): Promise<Payment[]>;
  /**
   * The invoice a checkout may charge: tenant-scoped, payable (not DRAFT/VOID)
   * with a positive balance — the guards for the Stripe flow live here.
   */
  getPayableInvoice(invoiceId: string): Promise<Invoice>;
  /** Create a SUCCEEDED payment and reconcile the invoice atomically. */
  record(data: PaymentRecordData, options?: { now?: Date }): Promise<PaymentMutationResult>;
  /** Open a Stripe flow: a PENDING row with the checkout identifiers, no money moved. */
  createPending(
    data: PaymentRecordData & {
      stripeCheckoutSessionId?: string | null;
      stripePaymentIntentId?: string | null;
    },
  ): Promise<Payment>;
  /** PENDING → SUCCEEDED + reconcile (Stripe webhook confirm). Idempotent on retries. */
  markSucceeded(
    id: string,
    options?: { now?: Date; stripePaymentIntentId?: string | null },
  ): Promise<PaymentMutationResult>;
  /** PENDING → FAILED (Stripe reported the payment failed; no money moved). */
  markFailed(id: string, options?: { now?: Date }): Promise<Payment>;
  /** PENDING → VOIDED (nothing to reverse) or SUCCEEDED → VOIDED (reverses). */
  void(id: string, options?: { now?: Date }): Promise<PaymentMutationResult>;
  /** SUCCEEDED → REFUNDED (reverses the invoice reconcile). */
  refund(id: string, options?: { now?: Date }): Promise<PaymentMutationResult>;
}

const customerSelect = { id: true, firstName: true, lastName: true, companyName: true } as const;
const invoiceSelect = {
  id: true,
  invoiceNumber: true,
  status: true,
  totalCents: true,
  paidCents: true,
  balanceCents: true,
} as const;

/** Builds the tenant-scoped where predicate shared by list/count (pure → tested). */
export function paymentListWhere(
  organizationId: string,
  params: PaymentListParams = {},
): Prisma.PaymentWhereInput {
  return {
    organizationId,
    ...(params.status ? { status: params.status } : {}),
    ...(params.method ? { method: params.method } : {}),
    ...(params.invoiceId ? { invoiceId: params.invoiceId } : {}),
    ...(params.customerId ? { customerId: params.customerId } : {}),
    ...(params.appliedFrom || params.appliedTo
      ? {
          appliedAt: {
            ...(params.appliedFrom ? { gte: params.appliedFrom } : {}),
            ...(params.appliedTo ? { lte: params.appliedTo } : {}),
          },
        }
      : {}),
  };
}

function isPrismaClient(client: Client): client is PrismaClient {
  return "$transaction" in client && typeof client.$transaction === "function";
}

export function createPaymentRepo(prisma: Client, organizationId: string): PaymentRepo {
  const tenant = { organizationId } as const;

  async function assertCustomer(customerId: string): Promise<void> {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, ...tenant }, select: { id: true } });
    if (!customer) throw new NotFoundError("The selected customer does not belong to this organization.");
  }

  /**
   * Increment/decrement the invoice's paidCents and drive its status in ONE
   * guarded write. Guards: payable status, no overpayment, no negative
   * paidCents, and the observed (status, paidCents) pair must still match.
   */
  async function reconcileInvoice(
    invoice: Invoice,
    amountCents: number,
    direction: "apply" | "reverse",
    now: Date,
  ): Promise<{ invoiceBefore: Invoice; invoiceAfter: Invoice }> {
    if (!canInvoiceReceivePayment(invoice.status)) {
      throw new ConflictError(
        invoice.status === "DRAFT"
          ? "A draft invoice cannot receive payments. Send it first."
          : "A voided invoice cannot receive payments.",
      );
    }
    const newPaidCents = direction === "apply" ? invoice.paidCents + amountCents : invoice.paidCents - amountCents;
    if (newPaidCents < 0) {
      throw new ConflictError("Reversing this payment would exceed the invoice's recorded paid amount.");
    }
    const newBalanceCents = invoice.totalCents - newPaidCents;
    if (newBalanceCents < 0) {
      throw new ConflictError(
        `This payment would overpay the invoice by ${-newBalanceCents} cents. Reduce the amount to at most the outstanding balance.`,
      );
    }
    const toStatus = invoiceStatusAfterPayment(invoice.status, newPaidCents, newBalanceCents);
    const paidAt = paidAtForPaymentTransition(invoice.status, toStatus, now);
    // Optimistic guard on the observed status AND paidCents: count 0 means a
    // concurrent write moved the invoice first — never a silent overwrite.
    const update = await prisma.invoice.updateMany({
      where: { id: invoice.id, ...tenant, status: invoice.status, paidCents: invoice.paidCents },
      data: {
        paidCents: newPaidCents,
        balanceCents: newBalanceCents,
        status: toStatus,
        ...(paidAt !== undefined ? { paidAt } : {}),
      },
    });
    if (update.count === 0) {
      throw new ConflictError("The invoice changed while the payment was being applied. Refresh and try again.");
    }
    const invoiceAfter = await prisma.invoice.findFirst({ where: { id: invoice.id, ...tenant } });
    if (!invoiceAfter) throw new NotFoundError("Invoice not found in this organization.");
    return { invoiceBefore: invoice, invoiceAfter };
  }

  async function updatePaymentStatus(
    payment: Payment,
    to: PaymentStatus,
    options?: { now?: Date; stripePaymentIntentId?: string | null },
  ): Promise<Payment> {
    applyPaymentStatusTransition(payment.status, to);
    const update = await prisma.payment.updateMany({
      where: { id: payment.id, ...tenant, status: payment.status },
      data: {
        status: to,
        ...(options?.stripePaymentIntentId ? { stripePaymentIntentId: options.stripePaymentIntentId } : {}),
      },
    });
    if (update.count === 0) {
      throw new ConflictError("Payment status changed before this transition could be applied. Refresh and try again.");
    }
    const updated = await prisma.payment.findFirst({ where: { id: payment.id, ...tenant } });
    if (!updated) throw new NotFoundError("Payment not found in this organization.");
    return updated;
  }

  async function recordInTransaction(data: PaymentRecordData, options?: { now?: Date }): Promise<PaymentMutationResult> {
    if (!Number.isSafeInteger(data.amountCents) || data.amountCents <= 0) {
      throw new ValidationError("A payment amount must be a whole number of cents greater than zero.");
    }
    const invoice = await prisma.invoice.findFirst({ where: { id: data.invoiceId, ...tenant } });
    if (!invoice) throw new NotFoundError("Invoice not found in this organization.");
    if (data.customerId) await assertCustomer(data.customerId);
    // Serialize concurrent recorders for this org (manual entry vs Stripe
    // webhook). See file header: $executeRaw for the void-column lock.
    await prisma.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
    const now = options?.now ?? new Date();
    const { invoiceBefore, invoiceAfter } = await reconcileInvoice(invoice, data.amountCents, "apply", now);
    const payment = await prisma.payment.create({
      data: {
        ...tenant,
        invoiceId: invoice.id,
        // Default the customer to the invoice's customer (the natural owner
        // of the money); an explicit override must be tenant-verified (above).
        customerId: data.customerId ?? invoice.customerId,
        amountCents: data.amountCents,
        method: data.method,
        status: "SUCCEEDED",
        notes: data.notes ?? null,
        appliedAt: now,
      },
    });
    return { payment, invoiceBefore, invoiceAfter };
  }

  async function mutationInTransaction(
    id: string,
    action: (payment: Payment) => Promise<PaymentMutationResult>,
  ): Promise<PaymentMutationResult> {
    const payment = await prisma.payment.findFirst({ where: { id, ...tenant } });
    if (!payment) throw new NotFoundError("Payment not found in this organization.");
    await prisma.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
    return action(payment);
  }

  async function voidInTransaction(id: string, options?: { now?: Date }): Promise<PaymentMutationResult> {
    return mutationInTransaction(id, async (payment) => {
      // Validates the map (PENDING/SUCCEEDED → VOIDED) or throws ConflictError.
      applyPaymentStatusTransition(payment.status, "VOIDED");
      if (payment.status === "SUCCEEDED") {
        // Reverse the reconcile: the money left (or was cancelled after the
        // fact), so the invoice's paid/balance must unwind in this same tx.
        const invoice = await prisma.invoice.findFirst({ where: { id: payment.invoiceId, ...tenant } });
        if (!invoice) throw new NotFoundError("Invoice not found in this organization.");
        const { invoiceBefore, invoiceAfter } = await reconcileInvoice(invoice, payment.amountCents, "reverse", options?.now ?? new Date());
        const updated = await updatePaymentStatus(payment, "VOIDED");
        return { payment: updated, invoiceBefore, invoiceAfter };
      }
      // PENDING → VOIDED: no money has moved, nothing to reconcile.
      const updated = await updatePaymentStatus(payment, "VOIDED");
      return { payment: updated, invoiceBefore: null, invoiceAfter: null };
    });
  }

  async function refundInTransaction(id: string, options?: { now?: Date }): Promise<PaymentMutationResult> {
    return mutationInTransaction(id, async (payment) => {
      // Fail fast BEFORE any reconcile write: only SUCCEEDED may refund
      // (PENDING has no money to reverse — void it instead; terminal rows
      // stay terminal).
      applyPaymentStatusTransition(payment.status, "REFUNDED");
      const invoice = await prisma.invoice.findFirst({ where: { id: payment.invoiceId, ...tenant } });
      if (!invoice) throw new NotFoundError("Invoice not found in this organization.");
      const { invoiceBefore, invoiceAfter } = await reconcileInvoice(invoice, payment.amountCents, "reverse", options?.now ?? new Date());
      const updated = await updatePaymentStatus(payment, "REFUNDED");
      return { payment: updated, invoiceBefore, invoiceAfter };
    });
  }

  return {
    async list(params = {}) {
      const { page = 1, pageSize = 25 } = params;
      const size = Math.max(1, Math.min(pageSize, 100));
      return prisma.payment.findMany({
        where: paymentListWhere(organizationId, params),
        include: {
          invoice: { select: invoiceSelect },
          customer: { select: customerSelect },
        },
        orderBy: [{ appliedAt: "desc" }, { createdAt: "desc" }],
        take: size,
        skip: (Math.max(1, page) - 1) * size,
      });
    },
    async count(params = {}) {
      return prisma.payment.count({ where: paymentListWhere(organizationId, params) });
    },
    async getById(id) {
      return prisma.payment.findFirst({ where: { id, ...tenant } });
    },
    async getDetail(id) {
      return prisma.payment.findFirst({
        where: { id, ...tenant },
        include: {
          invoice: { select: invoiceSelect },
          customer: { select: customerSelect },
        },
      });
    },
    async listForInvoice(invoiceId) {
      return prisma.payment.findMany({
        where: { invoiceId, ...tenant },
        orderBy: [{ appliedAt: "desc" }, { createdAt: "desc" }],
      });
    },
    async getPayableInvoice(invoiceId) {
      const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, ...tenant } });
      if (!invoice) throw new NotFoundError("Invoice not found in this organization.");
      if (!canInvoiceReceivePayment(invoice.status)) {
        throw new ConflictError(
          invoice.status === "DRAFT"
            ? "A draft invoice cannot receive payments. Send it first."
            : "A voided invoice cannot receive payments.",
        );
      }
      if (invoice.balanceCents <= 0) {
        throw new ConflictError("This invoice has no outstanding balance.");
      }
      return invoice;
    },
    async record(data, options) {
      return isPrismaClient(prisma)
        ? prisma.$transaction((tx) => createPaymentRepo(tx, organizationId).record(data, options))
        : recordInTransaction(data, options);
    },
    async createPending(data) {
      if (!Number.isSafeInteger(data.amountCents) || data.amountCents <= 0) {
        throw new ValidationError("A payment amount must be a whole number of cents greater than zero.");
      }
      const invoice = await prisma.invoice.findFirst({ where: { id: data.invoiceId, ...tenant } });
      if (!invoice) throw new NotFoundError("Invoice not found in this organization.");
      if (data.customerId) await assertCustomer(data.customerId);
      return prisma.payment.create({
        data: {
          ...tenant,
          invoiceId: invoice.id,
          customerId: data.customerId ?? invoice.customerId,
          amountCents: data.amountCents,
          method: data.method,
          status: "PENDING",
          notes: data.notes ?? null,
          ...(data.stripeCheckoutSessionId ? { stripeCheckoutSessionId: data.stripeCheckoutSessionId } : {}),
          ...(data.stripePaymentIntentId ? { stripePaymentIntentId: data.stripePaymentIntentId } : {}),
        },
      });
    },
    async markSucceeded(id, options) {
      if (isPrismaClient(prisma)) {
        return prisma.$transaction((tx) => createPaymentRepo(tx, organizationId).markSucceeded(id, options));
      }
      const result = await mutationInTransaction(id, async (payment) => {
        if (payment.status === "SUCCEEDED") {
          // Idempotent webhook retry — the payment already settled.
          return { payment, invoiceBefore: null, invoiceAfter: null };
        }
        // Fail fast BEFORE any reconcile write: only PENDING may settle
        // (FAILED/REFUNDED/VOIDED are rejected by the transition map).
        applyPaymentStatusTransition(payment.status, "SUCCEEDED");
        const invoice = await prisma.invoice.findFirst({ where: { id: payment.invoiceId, ...tenant } });
        if (!invoice) throw new NotFoundError("Invoice not found in this organization.");
        const { invoiceBefore, invoiceAfter } = await reconcileInvoice(invoice, payment.amountCents, "apply", options?.now ?? new Date());
        const updated = await updatePaymentStatus(payment, "SUCCEEDED", options);
        return { payment: updated, invoiceBefore, invoiceAfter };
      });
      return result;
    },
    async markFailed(id) {
      if (isPrismaClient(prisma)) {
        return prisma.$transaction((tx) => createPaymentRepo(tx, organizationId).markFailed(id));
      }
      const result = await mutationInTransaction(id, async (payment) => {
        if (payment.status === "FAILED") {
          // Idempotent webhook retry — already terminal for the same reason.
          return { payment, invoiceBefore: null, invoiceAfter: null };
        }
        const updated = await updatePaymentStatus(payment, "FAILED");
        return { payment: updated, invoiceBefore: null, invoiceAfter: null };
      });
      return result.payment;
    },
    async void(id, options) {
      return isPrismaClient(prisma)
        ? prisma.$transaction((tx) => createPaymentRepo(tx, organizationId).void(id, options))
        : voidInTransaction(id, options);
    },
    async refund(id, options) {
      return isPrismaClient(prisma)
        ? prisma.$transaction((tx) => createPaymentRepo(tx, organizationId).refund(id, options))
        : refundInTransaction(id, options);
    },
  };
}
