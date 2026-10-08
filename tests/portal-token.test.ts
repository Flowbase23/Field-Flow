/**
 * Portal token infrastructure (Slice P2-S4) — pure + fake-repo level, no
 * mocking needed, so this suite runs under BOTH bun test and vitest.
 *
 * Covers: token generation shape/entropy/uniqueness, the token-scoped portal
 * repository (a token resolves exactly one tenant's row — never another
 * tenant's), and ensurePortalToken's generate-once/stable-token semantics on
 * the estimate and invoice repositories.
 */
import { describe, expect, it } from "vitest";
import { NotFoundError } from "@/lib/errors";
import {
  PORTAL_TOKEN_PATTERN,
  generatePortalToken,
  portalTokenFingerprint,
} from "@/server/domain/portal-token";
import { createPortalRepo } from "@/server/repositories/portal.repo";
import { createEstimateRepo } from "@/server/repositories/estimate.repo";
import { createInvoiceRepo } from "@/server/repositories/invoice.repo";

const ORG_A = "org-a";
const ORG_B = "org-b";

describe("portal token generation", () => {
  it("produces 43-char base64url tokens (256-bit entropy, URL-safe)", () => {
    for (let i = 0; i < 25; i++) {
      const token = generatePortalToken();
      expect(token).toHaveLength(43);
      expect(token).toMatch(PORTAL_TOKEN_PATTERN);
    }
  });
  it("generates unique tokens (no collisions across a batch)", () => {
    const tokens = new Set(Array.from({ length: 500 }, generatePortalToken));
    expect(tokens.size).toBe(500);
  });
  it("exposes a non-reversible fingerprint (never the full token)", () => {
    const token = generatePortalToken();
    const fingerprint = portalTokenFingerprint(token);
    expect(fingerprint).not.toBe(token);
    expect(fingerprint).not.toContain(token);
    expect(fingerprint).toContain(token.slice(0, 8));
  });
  it("rejects malformed tokens by pattern", () => {
    expect(PORTAL_TOKEN_PATTERN.test("short")).toBe(false);
    expect(PORTAL_TOKEN_PATTERN.test("a".repeat(44))).toBe(false);
    expect(PORTAL_TOKEN_PATTERN.test("with$pecial!chars0000000000000000000000")).toBe(false);
  });
});

/** Two-tenant fake with only the reads/writes the portal paths use. */
type Row = Record<string, any>;
function makePrisma(rows: { estimates: Row[]; invoices: Row[] }) {
  const state = { estimates: [...rows.estimates], invoices: [...rows.invoices] };
  function match(where: any, collection: Row[]): Row[] {
    return collection.filter((row) => {
      if (where.portalToken !== undefined && row.portalToken !== where.portalToken) return false;
      if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
      if (where.id !== undefined && row.id !== where.id) return false;
      if (where.status !== undefined && row.status !== where.status) return false;
      return true;
    });
  }
  function model(name: "estimates" | "invoices", extra: (row: Row) => Row) {
    return {
      findFirst: async ({ where }: any) => {
        const row = match(where, state[name])[0];
        if (!row) return null;
        // Include-shaped reads (portal repo) get customer/organization attached.
        return { ...row, ...extra(row) };
      },
      findMany: async ({ where }: any) => match(where, state[name]),
      updateMany: async ({ where, data }: any) => {
        const row = match(where, state[name])[0];
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    };
  }
  return {
    $executeRaw: async () => 0,
    estimate: model("estimates", (row) => ({
      customer: { id: row.customerId, firstName: "Ana", lastName: null, companyName: null },
      organization: { id: row.organizationId, name: "Org", slug: "org", currency: "USD", timezone: "UTC" },
    })),
    invoice: model("invoices", (row) => ({
      customer: { id: row.customerId, firstName: "Ana", lastName: null, companyName: null },
      organization: { id: row.organizationId, name: "Org", slug: "org", currency: "USD", timezone: "UTC" },
      payments: [],
    })),
    state,
  } as never as any;
}

const TOKEN_A = generatePortalToken();
const TOKEN_B = generatePortalToken();
const twoTenants = {
  estimates: [
    { id: "est-a", organizationId: ORG_A, customerId: "cust-a", portalToken: TOKEN_A, status: "SENT" },
    { id: "est-b", organizationId: ORG_B, customerId: "cust-b", portalToken: TOKEN_B, status: "SENT" },
  ],
  invoices: [
    { id: "inv-a", organizationId: ORG_A, customerId: "cust-a", portalToken: TOKEN_A, status: "SENT", balanceCents: 5000 },
    { id: "inv-b", organizationId: ORG_B, customerId: "cust-b", portalToken: TOKEN_B, status: "SENT", balanceCents: 1 },
  ],
};

describe("portal repo tenant resolution by token", () => {
  it("resolves a token to exactly its own tenant's estimate (with org + customer)", async () => {
    const prisma = makePrisma(twoTenants);
    const view = await createPortalRepo(prisma).findEstimateByToken(TOKEN_A);
    expect(view).not.toBeNull();
    expect(view!.estimate.id).toBe("est-a");
    expect(view!.estimate.organizationId).toBe(ORG_A);
    expect(view!.organization.id).toBe(ORG_A);
    expect(view!.customer).toEqual({ id: "cust-a", firstName: "Ana", lastName: null, companyName: null });
  });
  it("never returns another tenant's row for a foreign token", async () => {
    const prisma = makePrisma(twoTenants);
    const viewA = await createPortalRepo(prisma).findEstimateByToken(TOKEN_A);
    const viewB = await createPortalRepo(prisma).findEstimateByToken(TOKEN_B);
    expect(viewA!.estimate.organizationId).toBe(ORG_A);
    expect(viewB!.estimate.organizationId).toBe(ORG_B);
    expect(viewA!.estimate.id).not.toBe(viewB!.estimate.id);
  });
  it("returns null for an unknown token (no existence oracle across tenants)", async () => {
    const prisma = makePrisma(twoTenants);
    expect(await createPortalRepo(prisma).findEstimateByToken(generatePortalToken())).toBeNull();
  });
  it("resolves the invoice view with payment history", async () => {
    const prisma = makePrisma(twoTenants);
    const view = await createPortalRepo(prisma).findInvoiceByToken(TOKEN_B);
    expect(view).not.toBeNull();
    expect(view!.invoice.id).toBe("inv-b");
    expect(view!.invoice.balanceCents).toBe(1);
    expect(view!.payments).toEqual([]);
  });
});

describe("ensurePortalToken (estimate + invoice repos)", () => {
  it("generates once, then returns the SAME token on every later call", async () => {
    const prisma = makePrisma({
      estimates: [{ id: "est-1", organizationId: ORG_A, portalToken: null, status: "DRAFT" }],
      invoices: [{ id: "inv-1", organizationId: ORG_A, portalToken: null, status: "DRAFT" }],
    });
    const estimates = createEstimateRepo(prisma, ORG_A);
    const first = await estimates.ensurePortalToken("est-1");
    expect(first.generated).toBe(true);
    expect(first.estimate.portalToken).toMatch(PORTAL_TOKEN_PATTERN);
    const second = await estimates.ensurePortalToken("est-1");
    expect(second.generated).toBe(false);
    expect(second.estimate.portalToken).toBe(first.estimate.portalToken);
    const invoices = createInvoiceRepo(prisma, ORG_A);
    const invoiceFirst = await invoices.ensurePortalToken("inv-1");
    expect(invoiceFirst.generated).toBe(true);
    expect(invoiceFirst.invoice.portalToken).toMatch(PORTAL_TOKEN_PATTERN);
  });
  it("never hands out a token across tenants (foreign row invisible)", async () => {
    const prisma = makePrisma(twoTenants);
    await expect(createEstimateRepo(prisma, ORG_B).ensurePortalToken("est-a")).rejects.toBeInstanceOf(NotFoundError);
    await expect(createInvoiceRepo(prisma, ORG_A).ensurePortalToken("inv-b")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("treats a concurrent race as generated=false and returns the stable token", async () => {
    const prisma = makePrisma({
      estimates: [{ id: "est-1", organizationId: ORG_A, portalToken: "already-set-token", status: "DRAFT" }],
      invoices: [],
    });
    const result = await createEstimateRepo(prisma, ORG_A).ensurePortalToken("est-1");
    expect(result.generated).toBe(false);
    expect(result.estimate.portalToken).toBe("already-set-token");
  });
  it("rejects an unknown id with NotFoundError", async () => {
    const prisma = makePrisma({ estimates: [], invoices: [] });
    await expect(createEstimateRepo(prisma, ORG_A).ensurePortalToken("est-x")).rejects.toBeInstanceOf(NotFoundError);
  });
});
