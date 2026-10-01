# FieldFlow platform app — operations runbook

Operational reference for developing, building, and verifying the FieldFlow
platform app (`/home/team/shared/fieldflow` — Next.js 16 + Prisma 6 +
Postgres/Neon). The README documents what is built per slice; this file is how
you run and verify it. All commands run from the repo root.

## 1. Prerequisites

- **Node.js ≥ 20** — used to run the Prisma CLI directly
  (`node node_modules/prisma/build/index.js`).
- **bun ≥ 1.4** — package manager, script runner, and the test runner
  (`bun test` is the project test gate).

## 2. One-time setup

```bash
bun install
cp .env.example .env.local    # fill in real values; .env* is gitignored
bunx prisma generate          # generate the Prisma client from prisma/schema.prisma
```

### Environment variables

| Variable | Used by | Where to get it |
|---|---|---|
| `DATABASE_URL` | Prisma CLI + runtime DB access | Provisioned Neon Postgres connection string (already set in this workspace) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Browser (ClerkProvider, SignIn/Up) | Clerk dashboard → API keys |
| `CLERK_SECRET_KEY` | Server (`auth()`, middleware, invite flow) | Clerk dashboard → API keys |
| `CLERK_WEBHOOK_SECRET` | `src/app/api/webhooks/clerk` (svix signature) | Clerk dashboard → Webhooks → endpoint → signing secret |
| `SEED_RUN=1` | `prisma/seed.ts` | Must be set explicitly to allow seeding (deliberate guard) |

**Clerk keys are NOT configured for this workspace yet** — live auth remains
PENDING LIVE VERIFICATION (§7). `bun test`, `bunx prisma validate`,
`bun run typecheck`, and `npx next build --webpack` all pass without Clerk keys.

## 3. Database workflow

Schema: `prisma/schema.prisma`. Migrations: `prisma/migrations/` — currently
`20260805225341_init`, which is **applied** to the provisioned Neon Postgres
(`DATABASE_URL` targets `neondb`; `prisma migrate status` reports the schema up
to date). That is a schema-level fact only — no application runtime write has
been exercised (§7).

```bash
DATABASE_URL=… bunx prisma generate        # regenerate client after schema edits
DATABASE_URL=… bunx prisma validate        # schema check (no DB connection needed)
DATABASE_URL=… bunx prisma migrate dev     # local dev: create/apply a migration
DATABASE_URL=… bunx prisma migrate deploy  # CI/deploy: apply pending migrations
DATABASE_URL=… bunx prisma migrate status  # which migrations are applied
```

Rules:

- **Never `prisma db push` on a shared database.** It syncs the schema without
  a migration record and drifts the shared Neon DB from `prisma/migrations/`.
- **Seed is double-guarded**: `prisma/seed.ts` refuses to run unless
  `SEED_RUN=1` is set, and refuses non-local `DATABASE_URL`s. Never point it at
  production data.
- Review destructive migrations before applying; commit every generated
  migration together with the change that introduced it.

## 4. Build, test, typecheck

```bash
bun test                       # unit tests — in-memory fakes, no Clerk/DB needed
bun run typecheck              # tsc --noEmit
DATABASE_URL=… bunx prisma validate
npx next build --webpack       # production build (also runs type checking)
```

- `--webpack` is **required** for both `build` and `dev` (the npm scripts
  already pass it): Turbopack rejects this workspace's out-of-project
  `node_modules` symlink (§5/§6).
- The test gate is `bun test`. `bun run test` (vitest) also runs the suite
  except `tests/authorization/require-org.test.ts`, which uses bun's
  `mock.module` and is excluded in `vitest.config.ts`.

## 5. Machine-reset restore procedure (this workspace)

`/home` is a small disk, so the heavy directories live OUTSIDE the repo as
symlinks. After the machine is replaced/rebuilt, restore from the repo root in
this order:

```bash
# 1. Recreate the external stores and repo symlinks
mkdir -p /tmp/fieldflow /var/tmp/ff-next
ln -s /tmp/fieldflow/node_modules node_modules     # repo/node_modules
ln -s /var/tmp/ff-next .next                       # repo/.next (build output)
ln -s /tmp/fieldflow/node_modules /var/tmp/node_modules  # needed by next build's page-data phase

# 2. Reinstall dependencies into the external store
bun install --force --frozen-lockfile --cache-dir /tmp/fieldflow-bun-cache

# 3. Regenerate the Prisma client (generated client is not committed)
bunx prisma generate

# 4. Verify the toolchain
bun test && bun run typecheck && npx next build --webpack
```

Notes:

- `/var/tmp/node_modules -> /tmp/fieldflow/node_modules` exists because built
  pages under the symlinked `.next` resolve packages from `/var/tmp` during
  the build's page-data phase; the build wipes `.next` each run, so the
  symlink must live in `/var/tmp`, not inside `.next`.
- If bun's flat layout stops resolving for node-based CLIs (prisma, next),
  check the self-link inside the store (`/tmp/fieldflow/node_modules` must be
  able to resolve its own packages) and re-create it if missing.
- Prisma is pinned to **v6**: the ratified schema targets the
  `prisma-client-js` generator, which Prisma 7 removed.

## 6. Why `--webpack` (gotcha)

Turbopack fails on this workspace because `node_modules` is an out-of-project
symlink (`/tmp/fieldflow/node_modules`). Next 16 supports
`next build --webpack` / `next dev --webpack`; the `build`/`dev` scripts in
`package.json` already pass it. Do not remove the flag.

## 7. Live-verification checklist — the remaining Phase 1 pass (DB runtime items now done — see §8; Clerk/remote items remain)

Everything below is written and unit-tested with in-memory fakes, but has not
been exercised against real infrastructure. **Do not mark Phase 1 complete
until each line passes.** Regression baseline first: `bun test`,
`bun run typecheck`, `DATABASE_URL=… bunx prisma validate`,
`npx next build --webpack` all green (verified at the Slice 6b commit).

### Blocked on Clerk keys (publishable + secret + webhook secret) AND a provisioned organization/membership in Clerk

- [ ] Sign-in/sign-up against live Clerk; `clerkMiddleware` route protection
      (public routes vs. protected app).
- [ ] `requireOrg()` request flow end-to-end: live session → local
      Organization/User/active Membership lookup → OrgContext with local ids.
- [ ] Clerk webhook receiver: svix signature verification + idempotent
      org/user/membership sync (mark-inactive-not-delete) against real event
      payloads.
- [ ] `inviteMember()` → Clerk `createOrganizationInvitation` → webhook
      acceptance flips the local membership active (custom role keys
      `org:dispatcher`, `org:technician`, `org:sales_rep`,
      `org:customer_portal_user` created in the Clerk dashboard first).
- [ ] Every protected page/action exercised under a live session: dashboard,
      customers, leads, schedule, jobs, settings/members, invite flow.

### Blocked on a test database (plus the Clerk items above)

- [x] Runtime DB writes: repository create/update/delete, audit rows written
      in the SAME transaction as mutations, against live Postgres. — DONE for
      repository writes through `tenantDb(organizationId)` (persistence +
      cross-tenant round-trips proven live by §8; the Clerk/webhook-driven
      write paths and audit-in-transaction still await live Clerk).
- [x] Cross-tenant rejection against live rows: real P2025s on compound
      `id_organizationId` selectors and real count-guard behavior. — DONE,
      see §8 (scripts/verify-live-db.ts, 31/31 assertions).
- [ ] Run integration tests against a dedicated TEST database — never the
      shared provisioned Neon instance.

### Blocked on a linked remote repository

- [ ] Remote backup of `main`; push/PR workflow established.

## 8. Live-database verification script (`scripts/verify-live-db.ts`)

Proves runtime persistence and cross-tenant isolation against the REAL
provisioned Postgres (Neon) — completing the two "Blocked on a test database"
items of §7. It is a standalone maintenance script, NOT part of the `bun test`
suite (the suite runs in-memory, without a database); do not wire it into
`package.json`'s test script or vitest.

Run (with `DATABASE_URL` exported — the provisioned Neon instance):

```bash
bun scripts/verify-live-db.ts
```

What it does — every row it creates is labelled with the marker
`zzverify-<epoch>` (org slugs, Clerk org/user ids, customer/location/job text):

1. Sweeps leftovers of any previous crashed run (re-runs are idempotent).
2. Creates two labelled organizations (A and B), one user + one active OWNER
   membership each, then — through `tenantDb(organizationId)` and the
   repositories, exactly as application code does — a customer + service
   location + job under org A (org-local jobNumber allocation included).
3. Asserts (31 checks): created rows round-trip field-for-field; org B reads
   of org A rows return null/empty (getById/getDetail/list/count across
   customers, locations, jobs, memberships); org B writes fail closed —
   `jobs.create` with A's customer/location → repo `NotFoundError`,
   `customers.setActive/update` → real Prisma P2025 on the compound
   `id_organizationId` selector, `jobs.updateStatus`/`memberships.updateRole`
   → count-guard `NotFoundError` — and A's rows are unchanged afterwards.
4. In a `finally`, deletes every created row in FK-safe order (job → location
   → customer → membership → user → organization, the organization delete
   cascading residue) and verifies ZERO residual marker rows — Neon is left
   clean regardless of assertion outcomes. If a run dies before cleanup,
   simply re-run: step 1 sweeps the marker rows.

Last full result (2026-10-01): 31/31 assertions passed, 0 residual rows.
That run also surfaced and fixed a live-only bug the in-memory tests could
never catch: `$queryRaw` cannot deserialize the `void` column returned by
`pg_advisory_xact_lock()` ("Failed to deserialize column of type 'void'"),
so `job.repo.ts` now acquires the lock with `$executeRaw` (which ignores the
empty result set). Job creation was silently broken against live Postgres
until then.
