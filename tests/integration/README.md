# tests/integration/

**Intentionally empty for now.**

This directory is reserved for LIVE integration tests — repository behavior
against a real Postgres test database and authorization flows against a real
Clerk session/webhook payloads.

They land in the Phase 1 **verification pass**, which is gated on:

1. Clerk keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
   `CLERK_WEBHOOK_SECRET`) and a provisioned organization/membership in Clerk.
2. A dedicated test database (never run integration tests against the shared
   provisioned Neon instance).

Everything that CAN be verified without that infrastructure already runs in
the unit suites (`tests/*.test.ts`, `tests/authorization/`) using in-memory
fakes — see `docs/runbook.md` §7 for the exact live-verification checklist.
Nothing here is a gap in the Slice 6b hardening gate; the empty directory is
deliberate and documented.
