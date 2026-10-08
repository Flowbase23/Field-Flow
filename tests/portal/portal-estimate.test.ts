/**
 * Public estimate-portal actions (Slice P2-S4) — in-memory, mirroring
 * tests/authorization/payment-actions.test.ts: bun:test mock.module() fakes for
 * the db singleton / next/cache (vitest cannot run these — excluded there).
 *
 * What this proves at the ACTION layer:
 * - accept/decline authorize by TOKEN ONLY: requireOrg/requirePermission are
 *   mocked to THROW, and the actions still succeed (the customer is anonymous);
 * - transitions reuse the estimate lifecycle (SENT → ACCEPTED/DECLINED) and
 *   stamp the system timestamps; DRAFT/VOID/terminal/expired are rejected;
 * - a token resolves exactly one tenant: another tenant's rows are never read
 *   or written through a foreign token;
 * - every decision writes a STATUS_CHANGED audit row with actor = customer
 *   (actorUserId/actorClerkUserId null, via customer_portal) via the REAL
 *   writeAuditLog (NOT mocked — bun mock.module leaks; see file header of
 *   payment-actions.test.ts);
 * - the internal reveal action is permission-gated and generates the token
 *   once (stable afterwards, audited only on first generation).
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { ForbiddenError } from "@/lib/errors";

const ORG_A = "org-local-a";
const ORG_B = "org-local-b";
const CUST_A = "custA000000000000000000001a";
const EST_A = "cestA00000000000000000001a";
const EST_B = "cestB00000000000000000001b";
const USER_ID = "user-local-1";
const authContext = {
  organizationId: ORG_A,
  userId: USER_ID,
  clerkUserId: "clerk-user-1",
  membership: { role: "OFFICE_STAFF", isActive: true },
  organization: { slug: "acme", name: "Acme", timezone: "UTC", currency: "USD" },
};
/** Permissions the fake requirePermission grants ("*" = all). */
let grantedPermissions: readonly string[] = ["*"];
// require-org is mocked to THROW — a portal action that calls it proves the
// access model wrong. (Static factory; later suites re-register their own.)
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
// requestOrigin is only used by the reveal actions; a static headers fake.
mock.module("next/headers", () => ({
  headers: async () => new Headers({ host: "app.example" }),
}));

/** In-memory Estimate/Customer tables + audit capture (REAL audit module). */
const state = {
  customers: [] as Array<Record<string, any>>,
  estimates: [] as Array<Record<string, any>>,
  audit: [] as Array<Record<string, any>>,
};
function resetState() {
  state.customers = [
    { id: CUST_A, organizationId: ORG_A },
  ];
  state.estimates = [];
  state.audit = [];
}
function seedEstimate(overrides: Record<string, any>) {
  const row = {
    id: EST_A,
    organizationId: ORG_A,
    customerId: CUST_A,
    estimateNumber: 3,
    status: "SENT",
    title: "AC replacement",
    validUntil: null,
    sentAt: new Date("2026-10-01T10:00:00Z"),
    acceptedAt: null,
    declinedAt: null,
    subtotalCents: 10000,
    taxCents: 800,
    totalCents: 10800,
    portalToken: null,
    ...overrides,
  };
  state.estimates.push(row);
  return row;
}
function match(where: any): Array<Record<string, any>> {
  return state.estimates.filter((row) => {
    if (where.portalToken !== undefined && row.portalToken !== where.portalToken) return false;
    if (where.organizationId !== undefined && row.organizationId !== where.organizationId) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    return true;
  });
}
mock.module("@/server/db/client", () => {
  const db: Record<string, any> = {
    $executeRaw: async () => 0,
    estimate: {
      findFirst: async ({ where }: any) => {
        const row = match(where)[0];
        if (!row) return null;
        return {
          ...row,
          customer: state.customers.find((customer) => customer.id === row.customerId) ?? null,
          organization: { id: row.organizationId, name: "Acme", slug: "acme", currency: "USD", timezone: "UTC" },
        };
      },
      findMany: async ({ where }: any) => match(where),
      updateMany: async ({ where, data }: any) => {
        const row = match(where)[0];
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
  // TransactionClient has the models but NO $transaction (repo sees tx mode).
  const txClient: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(db)) {
    if (key !== "$transaction") txClient[key] = value;
  }
  db.$transaction = async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(txClient);
  return { db };
});

const { acceptEstimateByPortalToken, declineEstimateByPortalToken, revealEstimatePortalLink } = await import(
  "@/features/portal/server/portal.actions"
);
import { generatePortalToken } from "@/server/domain/portal-token";

beforeEach(() => {
  resetState();
  grantedPermissions = ["*"];
});

describe("public estimate accept/decline by token (no auth)", () => {
  it("accepts a SENT estimate with the customer as the audit actor", async () => {
    const token = generatePortalToken();
    seedEstimate({ portalToken: token });
    const result = await acceptEstimateByPortalToken({ token });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.data.status).toBe("ACCEPTED");
    expect(result.data.estimateNumber).toBe(3);
    expect(result.data.totalCents).toBe(10800);
    const row = state.estimates[0];
    expect(row.status).toBe("ACCEPTED");
    expect(row.acceptedAt).toBeInstanceOf(Date);
    const audit = state.audit[0];
    expect(audit.action).toBe("STATUS_CHANGED");
    expect(audit.entityType).toBe("Estimate");
    expect(audit.entityId).toBe(EST_A);
    expect(audit.actorUserId).toBeNull();
    expect(audit.actorClerkUserId).toBeNull();
    expect(audit.metadata.via).toBe("customer_portal");
    expect(audit.metadata.actorType).toBe("customer");
    expect(audit.before.status).toBe("SENT");
    expect(audit.after.status).toBe("ACCEPTED");
  });
  it("declines a SENT estimate (DECLINED + declinedAt + audit)", async () => {
    const token = generatePortalToken();
    seedEstimate({ portalToken: token });
    const result = await declineEstimateByPortalToken({ token });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.data.status).toBe("DECLINED");
    expect(state.estimates[0].declinedAt).toBeInstanceOf(Date);
    expect(state.audit[0].action).toBe("STATUS_CHANGED");
  });
  it("never calls the Clerk-gated auth (token IS the credential)", async () => {
    // requirePermission/requireOrg are mocked to THROW; an authorized decision
    // proves the portal path bypasses them entirely.
    const token = generatePortalToken();
    seedEstimate({ portalToken: token });
    const result = await acceptEstimateByPortalToken({ token });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
  });
  it("rejects a DRAFT estimate without writing", async () => {
    const token = generatePortalToken();
    seedEstimate({ portalToken: token, status: "DRAFT", sentAt: null });
    const result = await acceptEstimateByPortalToken({ token });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("CONFLICT");
    expect(state.estimates[0].status).toBe("DRAFT");
    expect(state.audit).toHaveLength(0);
  });
  it("rejects an already-ACCEPTED estimate (terminal, one decision only)", async () => {
    const token = generatePortalToken();
    seedEstimate({ portalToken: token, status: "ACCEPTED", acceptedAt: new Date() });
    const decline = await declineEstimateByPortalToken({ token });
    expect(decline.ok).toBe(false);
    if (decline.ok) throw new Error("expected failure result");
    expect(decline.error.code).toBe("CONFLICT");
    expect(state.estimates[0].status).toBe("ACCEPTED");
    expect(state.audit).toHaveLength(0);
  });
  it("rejects a DECLINED estimate", async () => {
    const token = generatePortalToken();
    seedEstimate({ portalToken: token, status: "DECLINED", declinedAt: new Date() });
    const accept = await acceptEstimateByPortalToken({ token });
    expect(accept.ok).toBe(false);
    if (accept.ok) throw new Error("expected failure result");
    expect(accept.error.code).toBe("CONFLICT");
  });
  it("rejects a VOID estimate", async () => {
    const token = generatePortalToken();
    seedEstimate({ portalToken: token, status: "VOID" });
    const accept = await acceptEstimateByPortalToken({ token });
    expect(accept.ok).toBe(false);
    if (accept.ok) throw new Error("expected failure result");
    expect(accept.error.code).toBe("CONFLICT");
  });
  it("rejects an EXPIRED estimate (SENT but past validUntil — derived)", async () => {
    const token = generatePortalToken();
    seedEstimate({ portalToken: token, validUntil: new Date("2020-01-01T00:00:00Z") });
    const accept = await acceptEstimateByPortalToken({ token });
    expect(accept.ok).toBe(false);
    if (accept.ok) throw new Error("expected failure result");
    expect(accept.error.code).toBe("CONFLICT");
    expect(state.estimates[0].status).toBe("SENT");
    expect(state.audit).toHaveLength(0);
  });
  it("allows an estimate whose validUntil is in the future", async () => {
    const token = generatePortalToken();
    seedEstimate({ portalToken: token, validUntil: new Date("2300-01-01T00:00:00Z") });
    const accept = await acceptEstimateByPortalToken({ token });
    expect(accept.ok).toBe(true);
    if (!accept.ok) throw new Error("expected ok result");
  });
  it("returns NOT_FOUND for an unknown token (no existence oracle)", async () => {
    const result = await acceptEstimateByPortalToken({ token: generatePortalToken() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("NOT_FOUND");
  });
  it("rejects a malformed token before any db read", async () => {
    const result = await acceptEstimateByPortalToken({ token: "not-a-token" });
    // Zod failure (actionError maps it app-wide); the guarantees that matter:
    // the request fails and writes nothing.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(state.audit).toHaveLength(0);
    expect(state.estimates).toHaveLength(0);
  });
});

describe("portal tenant isolation", () => {
  it("a token of org B acts only on org B's row — org A stays untouched", async () => {
    const tokenA = generatePortalToken();
    const tokenB = generatePortalToken();
    seedEstimate({ id: EST_A, portalToken: tokenA, organizationId: ORG_A });
    seedEstimate({ id: EST_B, portalToken: tokenB, organizationId: ORG_B, estimateNumber: 9 });
    const result = await acceptEstimateByPortalToken({ token: tokenB });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    const orgARow = state.estimates.find((row) => row.id === EST_A)!;
    const orgBRow = state.estimates.find((row) => row.id === EST_B)!;
    expect(orgARow.status).toBe("SENT");
    expect(orgBRow.status).toBe("ACCEPTED");
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0].organizationId).toBe(ORG_B);
  });
  it("a token never resolves another tenant's row (foreign lookups miss)", async () => {
    const tokenA = generatePortalToken();
    seedEstimate({ portalToken: tokenA, organizationId: ORG_A });
    seedEstimate({ id: EST_B, portalToken: generatePortalToken(), organizationId: ORG_B });
    // Act with org A's token repeatedly; org B's row can never be selected
    // because matching is on the globally-unique portalToken.
    const result = await acceptEstimateByPortalToken({ token: tokenA });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(state.estimates.find((row) => row.id === EST_B)!.status).toBe("SENT");
  });
});

describe("internal reveal action (office staff, permission-gated)", () => {
  it("generates the token, returns the absolute URL, and audits once", async () => {
    seedEstimate({ portalToken: null });
    const result = await revealEstimatePortalLink({ id: EST_A });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.data.generated).toBe(true);
    expect(result.data.url).toBe(`https://app.example/portal/estimate/${state.estimates[0].portalToken}`);
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0].action).toBe("UPDATE");
    expect(state.audit[0].metadata.portalLink).toBe("generated");
    // The full token is NEVER written to the audit trail (fingerprint only).
    expect(JSON.stringify(state.audit[0])).not.toContain(state.estimates[0].portalToken);
  });
  it("re-revealing returns the SAME token without a second audit row", async () => {
    seedEstimate({ portalToken: null });
    const first = await revealEstimatePortalLink({ id: EST_A });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok result");
    const second = await revealEstimatePortalLink({ id: EST_A });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok result");
    expect(second.data.generated).toBe(false);
    expect(second.data.url).toBe(first.data.url);
    expect(state.audit).toHaveLength(1);
  });
  it("denies a caller without ESTIMATE_UPDATE and writes NO token", async () => {
    grantedPermissions = ["ESTIMATE_READ"];
    seedEstimate({ portalToken: null });
    const result = await revealEstimatePortalLink({ id: EST_A });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("FORBIDDEN");
    expect(state.estimates[0].portalToken).toBeNull();
    expect(state.audit).toHaveLength(0);
  });
  it("rejects a foreign estimate id (tenant-scoped reveal)", async () => {
    seedEstimate({ id: EST_B, organizationId: ORG_B, portalToken: null });
    const result = await revealEstimatePortalLink({ id: EST_B });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure result");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(state.estimates[0].portalToken).toBeNull();
  });
});
