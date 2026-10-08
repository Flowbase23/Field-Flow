/**
 * Portal repository (Phase 2 Slice P2-S4) — token-scoped reads for the public
 * customer portal routes (/portal/estimate/[token], /portal/invoice/[token]).
 *
 * This is the ONE repository that is not scoped by organizationId: the portal
 * has no session, and the bearer token is the credential. Tenant safety comes
 * from the token's construction, not from a predicate:
 * - `portalToken` is 256-bit random (unguessable, unenumerable) and
 *   GLOBALLY unique (@unique on both Estimate and Invoice);
 * - a lookup by token therefore resolves exactly one row — one tenant's — and
 *   the resolved row's organizationId then scopes every follow-up write, which
 *   goes through the regular tenant repositories (estimate.setStatus,
 *   payment.getPayableInvoice/createPending).
 *
 * The reads are deliberately narrow: only the summary fields a customer needs.
 * Internal-only data (job links, numbers beyond the document number) is not
 * exposed. Nothing here writes.
 */
import type {
  Customer,
  Estimate,
  Invoice,
  Payment,
  PrismaClient,
  Prisma,
} from "@prisma/client";

type Client = Prisma.TransactionClient | PrismaClient;

export interface PortalCustomer {
  id: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}
export interface PortalOrganization {
  id: string;
  name: string;
  slug: string;
  currency: string;
  timezone: string;
}
export interface PortalEstimateView {
  estimate: Estimate;
  customer: PortalCustomer;
  organization: PortalOrganization;
}
export interface PortalInvoiceView {
  invoice: Invoice;
  customer: PortalCustomer;
  organization: PortalOrganization;
  /** Recent payment history for the read-only summary (already reconciled). */
  payments: Array<Pick<Payment, "id" | "amountCents" | "method" | "status" | "appliedAt">>;
}

const customerSelect = { id: true, firstName: true, lastName: true, companyName: true } as const;
const organizationSelect = { id: true, name: true, slug: true, currency: true, timezone: true } as const;
const paymentSelect = { id: true, amountCents: true, method: true, status: true, appliedAt: true } as const;

export interface PortalRepo {
  /** The estimate a token belongs to (customer + organization included). */
  findEstimateByToken(token: string): Promise<PortalEstimateView | null>;
  /** The invoice a token belongs to, with recent payment history. */
  findInvoiceByToken(token: string): Promise<PortalInvoiceView | null>;
}

export function createPortalRepo(prisma: Client): PortalRepo {
  return {
    async findEstimateByToken(token) {
      const estimate = await prisma.estimate.findFirst({
        // No organizationId predicate on purpose — see file header. The token's
        // global uniqueness resolves exactly one tenant's row.
        where: { portalToken: token },
        include: {
          customer: { select: customerSelect },
          organization: { select: organizationSelect },
        },
      });
      if (!estimate) return null;
      const { customer, organization, ...estimateRow } = estimate as Estimate & {
        customer: PortalCustomer;
        organization: PortalOrganization;
      };
      return { estimate: estimateRow, customer, organization };
    },
    async findInvoiceByToken(token) {
      const invoice = await prisma.invoice.findFirst({
        where: { portalToken: token },
        include: {
          customer: { select: customerSelect },
          organization: { select: organizationSelect },
          payments: { select: paymentSelect, orderBy: [{ appliedAt: "desc" }], take: 10 },
        },
      });
      if (!invoice) return null;
      const { customer, organization, payments, ...invoiceRow } = invoice as Invoice & {
        customer: PortalCustomer;
        organization: PortalOrganization;
        payments: PortalInvoiceView["payments"];
      };
      return { invoice: invoiceRow, customer, organization, payments };
    },
  };
}
