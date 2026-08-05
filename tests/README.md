# tests/

Planned test suites for Phase 1 (from the design's DoD and risk register):

- `integration/` — repository/tenantDb behavior against a real Postgres test DB.
- `authorization/` — requireOrg/requirePermission/requireRole: cross-tenant
  rejection, inactive membership, RolePermission overrides, no self-elevation.
- `fixtures/` — known demo org/user ids and factories.

Nothing runs here yet: the suites need a live test database (DATABASE_URL) and,
for authorization flows, a Clerk session or webhook payload fixtures. Once a
test DB exists, wire a runner (vitest) and implement:

1. customerRepo.list/getById/update reject or exclude rows from other orgs.
2. Compound `id_organizationId` selectors throw P2025 on cross-tenant updates.
3. requireOrg() throws UnauthorizedError without session/org and
   ForbiddenError without an active membership.
4. Webhook handlers are idempotent and mark-inactive-not-delete.
