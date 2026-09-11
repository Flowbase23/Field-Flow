# tests/

Unit suites for Phase 1, run with **`bun test`** (the project test gate) — all
in-memory fakes; no live Clerk or database is needed.

- Root-level `*.test.ts` — schemas, domain logic, and repository behavior
  (CRM schemas, duplicate policy, lead pipeline, appointment transitions/links,
  conflicts, job repository/dispatch invariants/transitions/UI, dashboard date
  ranges, query parsing, and dashboard metrics).
- `authorization/` — the authz and tenant-isolation suites (Slice 6b):
  - `require-org.test.ts` — requireOrg/requirePermission/requireRole with
    mocked Clerk `auth()` and an in-memory db. Uses `bun:test mock.module`
    (bun's runner ignores `vi.mock`), so it is excluded from vitest — see
    `vitest.config.ts`. The gate is `bun test`.
  - `role-permissions.test.ts` — role → permission matrix, least-privilege
    denials, and the pure helpers (extends the top-level
    `permissions.test.ts` smoke test).
  - `cross-tenant-predicates.test.ts` — consolidated tenant-isolation suite:
    predicate-injection sweep over every tenant repository read/write,
    cross-tenant rejection (foreign rows invisible or `NotFoundError`/P2025),
    and a source contract over the server actions.
- `integration/` — **intentionally empty** for now: live DB/Clerk integration
  tests land in the Phase 1 verification pass (blocked on Clerk keys, a
  provisioned org, and a dedicated test database). See `docs/runbook.md` §7.
- `fixtures/` — reserved for shared factories/ids.

Still PENDING LIVE VERIFICATION (cannot be verified with fakes; lands in the
verification pass):

1. Live-row cross-tenant rejection (real P2025s on compound selectors, real
   count guards) — the predicate/rejection seams are covered at the fake-DB
   level by `cross-tenant-predicates.test.ts`.
2. `requireOrg()` against a live Clerk session and middleware route protection.
3. Webhook idempotency against real Clerk payloads.
