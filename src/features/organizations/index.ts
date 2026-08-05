/**
 * features/organizations — org bootstrap, settings and membership (Slice 2).
 *
 * Org creation/switching UX, timezone/currency settings, membership
 * invite/deactivate. The local Organization/Membership/RolePermission rows are
 * synced from Clerk via the webhook (src/app/api/webhooks/clerk/route.ts);
 * requireOrg() is the runtime gate.
 */
export {};
