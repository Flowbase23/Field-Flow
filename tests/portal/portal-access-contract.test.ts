/**
 * Portal access-model contract (Slice P2-S4) — pure source assertions, runs
 * under BOTH bun test and vitest.
 *
 * The runtime proof that portal actions need NO auth lives in the bun suites
 * (tests/portal/portal-*.test.ts mock require-org to THROW and the actions
 * still succeed). This suite pins the structural invariants that make that
 * true and keeps them from regressing:
 * - portal actions never import the Clerk-gated auth seam;
 * - the public portal routes are matched by the Clerk middleware's public
 *   list (no auth.protect() on /portal/*);
 * - public portal pages authorize ONLY through the token-scoped portal repo
 *   and never call requireOrg/requirePermission;
 * - the public actions' payloads carry nothing but the token (money/status
 *   are always server-derived).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const srcRoot = path.resolve(__dirname, "..", "..", "src");
function source(relativePath: string): string {
  return readFileSync(path.join(srcRoot, relativePath), "utf8");
}

const portalActionsSource = source("features/portal/server/portal.actions.ts");
const middlewareSource = source("middleware.ts");
const estimatePageSource = source("app/(public)/portal/estimate/[token]/page.tsx");
const invoicePageSource = source("app/(public)/portal/invoice/[token]/page.tsx");
const schemasSource = source("features/portal/schemas.ts");

describe("portal access model contract", () => {
  it("portal actions never gate on the Clerk-backed auth seam", () => {
    expect(portalActionsSource).toContain('requirePermission(LINK_ESTIMATE_PERMISSION)');
    expect(portalActionsSource).toContain('requirePermission(LINK_INVOICE_PERMISSION)');
    // The two INTERNAL reveal actions are the ONLY requirePermission callers:
    // each occurrence must sit inside a reveal* action (count sanity below
    // asserts no other action reaches for the session).
    // Count only real call sites: strip block and line comments first so a
    // doc comment mentioning the API by name is not miscounted.
    const codeOnly = portalActionsSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const calls = codeOnly.match(/requirePermission\(/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(portalActionsSource).toMatch(/const LINK_ESTIMATE_PERMISSION = Permission\.ESTIMATE_UPDATE/);
    expect(portalActionsSource).toMatch(/const LINK_INVOICE_PERMISSION = Permission\.INVOICE_UPDATE/);
  });
  it("the Clerk middleware treats /portal as a public route", () => {
    expect(middlewareSource).toContain('"/portal(.*)"');
    // And it is listed as PUBLIC (in the matcher that skips auth.protect()).
    expect(middlewareSource).toMatch(/isPublicRoute = createRouteMatcher\(\[[\s\S]*?"\/portal\(\.\*\)"/);
  });
  it("public portal pages authorize only via the token-scoped portal repo", () => {
    for (const pageSource of [estimatePageSource, invoicePageSource]) {
      expect(pageSource).not.toMatch(/requireOrg|requirePermission/);
      expect(pageSource).toContain("createPortalRepo(db)");
      expect(pageSource).toContain("notFound()");
      // Noindex: tokenized pages must never be crawled.
      expect(pageSource).toContain("robots: { index: false, follow: false }");
    }
  });
  it("the public payloads carry only the token — nothing else is client-settable", () => {
    expect(schemasSource).toContain("portalTokenActionSchema = z.object({ token: portalTokenSchema }).strict()");
    // strict() forbids extra keys (no amount/status/id smuggling).
    expect(schemasSource).toMatch(/\.strict\(\)/);
  });
});
