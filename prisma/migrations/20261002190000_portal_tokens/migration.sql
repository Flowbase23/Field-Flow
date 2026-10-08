-- Phase 2 Slice P2-S4: customer portal link tokens.
-- Add a globally-unique, high-entropy (256-bit base64url) portal token to
-- Estimate and Invoice. Nullable + generated on demand: existing rows keep
-- NULL until office staff opens a customer link from the internal detail UI.
-- Portal routes authorize purely by this token (no Clerk session); because the
-- token is globally unique, a lookup by token resolves exactly one tenant's row.

ALTER TABLE "Estimate" ADD COLUMN "portalToken" TEXT;

CREATE UNIQUE INDEX "Estimate_portalToken_key" ON "Estimate"("portalToken");

ALTER TABLE "Invoice" ADD COLUMN "portalToken" TEXT;

CREATE UNIQUE INDEX "Invoice_portalToken_key" ON "Invoice"("portalToken");
