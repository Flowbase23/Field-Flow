/**
 * Zod contracts for the customer portal (Slice P2-S4).
 *
 * Two very different payload families live here:
 * - Internal "copy customer link" actions: carry a document id and are gated by
 *   requirePermission (ESTIMATE_UPDATE / INVOICE_UPDATE) like every other
 *   authenticated action.
 * - Public portal actions: carry ONLY the portal token. There is no session and
 *   no other client-supplied value — the customer never sends an amount, a
 *   status, or an id; everything else is derived server-side from the row the
 *   token resolves to (money stays server-authoritative).
 */
import { z } from "zod";
import { cuidSchema } from "@/features/customers/schemas";
import { PORTAL_TOKEN_PATTERN } from "@/server/domain/portal-token";

/** A portal token is exactly the shape generatePortalToken() produces. */
export const portalTokenSchema = z
  .string()
  .trim()
  .regex(PORTAL_TOKEN_PATTERN, "This customer link is not valid.");

/** Public portal actions: the token is the ONLY client-supplied value. */
export const portalTokenActionSchema = z.object({ token: portalTokenSchema }).strict();

/** Internal "copy customer link" actions (permission-gated, office staff). */
export const portalLinkRevealSchema = z.object({ id: cuidSchema }).strict();

export type PortalTokenActionInput = z.infer<typeof portalTokenActionSchema>;
export type PortalLinkRevealInput = z.infer<typeof portalLinkRevealSchema>;
