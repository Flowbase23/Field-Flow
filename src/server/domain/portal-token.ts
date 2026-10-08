/**
 * Customer portal link tokens (Phase 2 Slice P2-S4).
 *
 * The portal has NO customer accounts and NO Clerk session: a link authorizes
 * purely by possessing a high-entropy token stored on the Estimate/Invoice row.
 * 256 bits of randomness (32 bytes → 43-char base64url) means links cannot be
 * guessed or enumerated, and the token's global uniqueness IS the tenant scope:
 * a lookup by token resolves exactly one organization's row, and every
 * follow-up write is tenant-scoped by that resolved organizationId through the
 * regular tenant repositories (see src/server/repositories/portal.repo.ts).
 *
 * Server-only module (node:crypto) — never import from client code.
 */
import { randomBytes } from "node:crypto";

/** 32 random bytes → 43-char unpadded base64url (URL-safe, no reserved chars). */
export function generatePortalToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A portal token must be exactly the shape generatePortalToken produces. */
export const PORTAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Non-reversible fingerprint for audit metadata: enough to correlate audit
 * entries with a token when investigating, never the token itself (audit rows
 * are broadly readable inside the org, while the token is a bearer secret).
 */
export function portalTokenFingerprint(token: string): string {
  return `${token.slice(0, 8)}…(${token.length})`;
}
