# FieldFlow — Phase 1, Slice 1 (scaffold, database, auth, org foundation)

FieldFlow is a multi-tenant SaaS platform for HVAC, plumbing, and electrical companies
(2–100 technicians): CRM, scheduling & dispatching, jobs, invoicing, customer
communication, and reporting in one app. This repository is the **platform app**
(Next.js). The public marketing site is a separate app (`/home/team/shared/site`).

Architecture authority: `/home/team/shared/phase1-design.md` (ratified-by-team
design). Read it before changing schema or authz decisions.

## Slice 2 — shell & RBAC

The tenant shell at `(app)/[orgSlug]` calls `requireOrg()` at the layout boundary and derives the effective role permissions from the local membership plus `RolePermission` overrides. Navigation is permission-filtered, while each page independently calls `requirePermission()` for defense in depth. Use `can(permissions, permission)` or `<RequirePermission>` for UI actions; server actions must still call `requirePermission()` and write an audit entry. The Members view is tenant-scoped and marks Clerk invitations/mutations **PENDING LIVE VERIFICATION** until Clerk keys are configured; self role/status changes are rejected by `canChangeMembership`.

Dashboard KPI cards are empty-state placeholders with definitions for today's jobs, in-progress, completed, revenue today/month (revenue definition remains configurable pending owner decision), outstanding invoices, average ticket, technician utilization, lead conversion, and missed appointments. Organization timezone is used by `orgDayRange()` in `src/lib/dates.ts`.

### Slice 2 follow-up — members/settings mutation server actions

Three server actions under `src/features/organizations/` complete the members/settings slice:

| Action | File | Guards | Audit action |
|---|---|---|---|
| `changeRole(membershipId, role)` | `server/members.actions.ts` | `requirePermission(MEMBERS_MANAGE)`, Zod `Role` enum, tenant-scoped target (`membership.repo`), `canChangeMembership` self-rule | `ROLE_CHANGED` (before/after) |
| `setMemberActive(membershipId, isActive)` | `server/members.actions.ts` | same as above | `STATUS_CHANGED` (before/after) |
| `inviteMember(email, role)` | `server/members.actions.ts` | `requirePermission(MEMBERS_MANAGE)`, Zod email+role, conflict-check on active memberships | `INVITE_SENT` |
| `updateOrg({ name, timezone, currency })` | `server/org.actions.ts` | `requirePermission(ORGANIZATION_UPDATE)`, Zod name (trimmed) / IANA timezone (`Intl` check) / 3-letter ISO 4217 currency | `UPDATE` (before/after) |

Conventions: every action starts with `requirePermission`, validates with a Zod schema from `src/features/organizations/schemas.ts` (shared with the client forms), reaches the `Membership` model only through the tenant-scoped `src/server/repositories/membership.repo.ts` (registered on `tenantDb`), writes its audit row in the same transaction via `withAudit`, and returns `ActionResult` so the UI can surface typed errors. Role/status/org-settings mutations are fully local — they work against the live `DATABASE_URL` once a session exists.

**`inviteMember` is PENDING LIVE VERIFICATION.** Clerk is the invitation source and the flow is Clerk-first: it calls `clerkClient().organizations.createOrganizationInvitation(...)` with the session org's `clerkOrganizationId`, and only on success upserts a pending (inactive) local `Membership` for invitees who are already known local users (the webhook flips it active on acceptance). Without `CLERK_SECRET_KEY` it fails closed (`CLERK_NOT_CONFIGURED`). The custom Clerk role keys used for non-admin roles (`org:dispatcher`, `org:technician`, `org:sales_rep`, `org:customer_portal_user`) must be created in the Clerk dashboard; the shared mapping lives in `src/features/organizations/clerk-roles.ts` and the webhook now uses it in reverse, so an invite sent with `org:technician` lands as a `TECHNICIAN` membership on acceptance.

The Settings page form and the Members page controls are permission-gated (`can()`/`canManage` prop computed server-side) with self-mutation always disabled; the Members page hides the invite form without `MEMBERS_MANAGE`.

## What's built (Slice 1)

- **Next.js 16 (App Router) + TypeScript (strict) + Tailwind v4 + shadcn/ui** shell.
- **Full Phase 1 Prisma schema** (`prisma/schema.prisma`): single-Postgres
  multi-tenancy, `organizationId` on every tenant model, all Phase 1 enums,
  indexes, compound FKs, and audit log. `prisma validate` passes.
- **Clerk auth foundation**: `requireOrg()` / `requirePermission()` /
  `requireRole()` in `src/server/auth/require-org.ts`; Clerk middleware with
  public-route list in `src/middleware.ts`; Clerk webhook receiver
  (`src/app/api/webhooks/clerk/route.ts`) that idempotently syncs
  organizations/users/memberships (mark-inactive-not-delete).
- **Permission model**: `Role → Permission[]` defaults +
  per-organization `RolePermission` overrides in `src/server/auth/permissions.ts`.
- **Tenant-scoped DB layer**: Prisma singleton (`src/server/db/client.ts`) and
  `tenantDb(organizationId)` / repositories (`src/server/repositories/`) that
  inject the org predicate on every query; `customerRepo` is the fully worked
  example, other repos are explicit stubs (throw `NotImplementedError`).
- **Audit helper** (`src/server/audit/`): append-only AuditLog writes, JSON
  snapshots via `toAuditJson`, transactional `withAudit()`.
- **App shell**: `(public)` sign-in/sign-up stubs, `(app)/[orgSlug]` layout with
  org shell, dashboard placeholder and per-route `requirePermission` gates.
- **Lib**: typed errors (`src/lib/errors.ts`), timezone-safe dates
  (`src/lib/dates.ts`), integer-cents money (`src/lib/money.ts`), Zod schemas
  (`src/lib/validation.ts`).

## How to run

Prerequisites: Node ≥ 20, bun. This machine has a small `/home` disk; heavy dirs
are symlinked to `/var/tmp` (see "Machine-specific notes" below).

```bash
bun install
cp .env.example .env.local   # fill in real values
bun run db:generate          # prisma generate (needs DATABASE_URL? no — generate doesn't)
DATABASE_URL="postgresql://..." bun run db:validate
bun run dev                  # dev server (requires Clerk keys at runtime)
bun run build                # production build (typecheck + Turbopack)
bun run start                # serve the build
```

No live database exists yet, so nothing here connects to Postgres: `prisma
validate` (schema check) and `next build` both pass without a real DATABASE_URL.

### Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | Prisma CLI + runtime DB access | postgres://…; no DB provisioned yet |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Browser (ClerkProvider, SignIn/Up) | Clerk dashboard → API keys |
| `CLERK_SECRET_KEY` | Server (auth(), middleware) | Clerk dashboard → API keys |
| `CLERK_WEBHOOK_SECRET` | Webhook signature verification | Clerk dashboard → Webhooks |
| `SEED_RUN=1` | `prisma/seed.ts` | Guard so seed never runs by accident |

See `.env.example` for full comments.

### Database migration workflow (when a DB exists)

1. Local: `DATABASE_URL=… bun run db:migrate` (wraps `prisma migrate dev`).
2. CI/deploy: `DATABASE_URL=… bun run db:deploy` (wraps `prisma migrate deploy`).
3. Never `prisma db push` on a shared database. Review destructive migrations.
4. Commit every generated migration under `prisma/migrations/`.

## What's blocked on live credentials (pending live verification)

Everything below is written and type-checks, but cannot be exercised without a
real environment. All of these are marked `PENDING LIVE VERIFICATION` in code:

1. `DATABASE_URL` — no Postgres exists; repositories/audit/webhook DB writes are
   untested against a live database (cross-tenant rejection tests are planned in
   `tests/` once a test DB exists).
2. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` — ClerkProvider,
   sign-in/sign-up, `auth()`, `clerkMiddleware` throw without them; the
   requireOrg() request flow and middleware route protection must be verified
   with a live session and org.
3. `CLERK_WEBHOOK_SECRET` — svix signature verification and the exact payload
   shapes of the webhook events must be verified against a real Clerk endpoint
   (types are taken from `@clerk/backend`).

## Tenant isolation conventions (non-negotiable)

1. **Every protected route/action starts with `requireOrg()` (or
   requirePermission/requireRole).** The tenant id comes ONLY from the Clerk
   session — never from the browser (no `organizationId`/slug from query params).
2. **Tenant models are never queried with the global `db` client from feature
   code.** Use `tenantDb(organizationId)` / the repositories in
   `src/server/repositories/`, which inject `organizationId` on every query.
3. **No raw SQL** (`$queryRaw*`) for tenant models — it bypasses the tenant
   predicate. Use typed Prisma calls through repositories.
4. **Compound FKs** (`@@unique([id, organizationId])`) make cross-tenant
   relations impossible at the DB level for required links. Optional links
   (Lead.customer, Job.lead, Appointment.job/location, TimeEntry.job,
   Invoice.job) use id-only FKs because Prisma requires ALL FK columns of an
   optional relation to be nullable and `organizationId` is intentionally
   non-null — tenant safety for those is enforced by the repository layer
   (documented in `prisma/schema.prisma` header).
5. **Every authorization-sensitive action writes an AuditLog** via
   `src/server/audit/` (append-only).
6. **Fail closed**: missing org/user/membership → typed Unauthorized/Forbidden
   error; webhooks treat a missing org as "not provisioned" and never guess.

## Repository layout

```
src/
├── app/
│   ├── (public)/          sign-in, sign-up, "/"
│   ├── (app)/[orgSlug]/   org shell: dashboard, customers, leads, schedule, jobs, settings
│   └── api/webhooks/clerk/  Clerk sync webhook (svix-verified)
├── components/            ui/ (shadcn), layout/ (org shell), providers (TanStack Query)
├── features/              dashboard, customers, leads, jobs, schedule, organizations, users
├── server/
│   ├── auth/              require-org.ts, permissions.ts
│   ├── db/                client.ts (singleton), tenant-db.ts
│   ├── repositories/      customer.repo.ts (worked example) + stubs
│   ├── audit/             append-only audit writes
│   ├── services/          (later slices)
│   └── jobs/              (later slices — BullMQ behind this boundary)
├── lib/                   errors.ts, dates.ts, money.ts, validation.ts
└── middleware.ts          Clerk route protection
prisma/                    schema.prisma, migrations/ (none yet), seed.ts
tests/                     planned integration/authorization suites (need a test DB)
```

Deviation notes from the design tree: `globals.css` lives in `src/styles/`
per the design (imported by the root layout); `middleware.ts` sits in `src/`
(the src-dir convention, equivalent to root-level). `src/app/globals.css` was
moved accordingly.

## Machine-specific notes (this workspace only)

- `/home` (fs0) is only 300 MB; `node_modules` and `.next` are symlinks to
  `/var/tmp/ff-nm` and `/var/tmp/ff-next`. Recreating them after a wipe:
  `mkdir -p /var/tmp/ff-nm /var/tmp/ff-next && ln -s /var/tmp/ff-nm node_modules && ln -s /var/tmp/ff-next .next`
  then `bun install`. `/var/tmp/ff-nm/node_modules` is a self-symlink needed for
  Node-based CLIs (prisma, next) to resolve packages under bun's flat layout —
  re-create with `cd /var/tmp/ff-nm && ln -s . node_modules` if it disappears.
  `/var/tmp/node_modules -> /var/tmp/ff-nm` is required for `next build`'s
  page-data phase (built pages live under the symlinked `.next`); the build
  wipes `.next` each run, so the symlink must live in `/var/tmp`, not in `.next`.
- Because Turbopack rejects the out-of-project `node_modules` symlink, the
  `build`/`dev` scripts pass `--webpack` (supported in Next 16).
- Prisma is pinned to v6 because the ratified schema sketch targets the
  `prisma-client-js` generator, which Prisma 7 removed.
- Prefer running the Prisma CLI via `node node_modules/prisma/build/index.js`
  (or `bunx prisma`) with `DATABASE_URL` exported; `bun run db:*` scripts wrap it.
