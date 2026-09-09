# FieldFlow — Phase 1, Slice 1 (scaffold, database, auth, org foundation)

FieldFlow is a multi-tenant SaaS platform for HVAC, plumbing, and electrical companies
(2–100 technicians): CRM, scheduling & dispatching, jobs, invoicing, customer
communication, and reporting in one app. This repository is the **platform app**
(Next.js). The public marketing site is a separate app (`/home/team/shared/site`).

Architecture authority: `/home/team/shared/phase1-design.md` (ratified-by-team
design). Read it before changing schema or authz decisions.

## Slice 2 — shell & RBAC

The tenant shell at `(app)/[orgSlug]` calls `requireOrg()` at the layout boundary and derives the effective role permissions from the local membership plus `RolePermission` overrides. Navigation is permission-filtered, while each page independently calls `requirePermission()` for defense in depth. Use `can(permissions, permission)` or `<RequirePermission>` for UI actions; server actions must still call `requirePermission()` and write an audit entry. The Members view is tenant-scoped and marks Clerk invitations/mutations **PENDING LIVE VERIFICATION** until Clerk keys are configured; self role/status changes are rejected by `canChangeMembership`.

The Phase 1 dashboard at `/{orgSlug}/` is `DASHBOARD_READ`-gated and URL-backed with `period=today|last7Days|last30Days|custom` (custom also requires inclusive `startDate`/`endDate` in `YYYY-MM-DD`). Its ranges use the organization IANA timezone and invalid query input fails closed to today. It renders only implemented Phase 1 metrics: today’s jobs, in-progress jobs, completed jobs, **completed-job revenue**, average ticket, lead conversion, and missed appointments. **completed-job revenue** is the engineering working assumption pending owner confirmation: the integer-cent sum of `actualRevenueCents` for jobs completed in the selected period — it is not paid-invoice revenue. Invoice balances, payment revenue, and TimeEntry-based utilization remain Phase 2 work.

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

## Slice 3 — CRM (customers, locations, leads)
The CRM slice is code-complete. All reads/writes are tenant-scoped (repos inject the organizationId predicate), permission-gated (server actions re-check `requirePermission`), audited (append-only AuditLog rows in the same transaction via `withAudit`) and validated with Zod (schemas in `features/customers/schemas.ts` and `features/leads/schemas.ts`, shared with client forms).

### Pages
| Route | Permission | What it does |
|---|---|---|
| `/customers` | `CUSTOMER_READ` | List with search (name/company/email/phone), type filter, active/inactive filter, pagination, status badges, deactivate/reactivate row action |
| `/customers/new` | `CUSTOMER_CREATE` | Create form (server action `createCustomer`) |
| `/customers/[id]` | `CUSTOMER_READ` (+ `LEAD_READ`/`JOB_READ` for sections) | Detail: header, locations manager, linked leads, jobs empty state (Slice 5), timeline placeholder (Phase 2) |
| `/customers/[id]/edit` | `CUSTOMER_UPDATE` | Edit form (server action `updateCustomer`) |
| `/leads` | `LEAD_READ` | List with status filter, source filter, search, pagination |
| `/leads/new` | `LEAD_CREATE` | Create form incl. sales-rep assignment + optional customer link |
| `/leads/[id]` | `LEAD_READ` (+ `LEAD_UPDATE` for controls) | Detail: description, pipeline controls, customer association, edit link |
| `/leads/[id]/edit` | `LEAD_UPDATE` | Full edit (status NOT editable here — pipeline only) |

### Duplicate policy
On customer create (and update when email/phone change), an existing **active** customer in the same org with the same email (case-insensitive) or phone blocks the write with a 409 `ConflictError` telling the operator to **link to the existing record instead** (`features/customers/duplicates.ts` — pure logic, unit-tested). Inactive (soft-deleted) customers never block. Reactivation is `CUSTOMER_UPDATE`-gated; deactivation is `CUSTOMER_DELETE`-gated; both audit `STATUS_CHANGED`.

### Lead pipeline (server-enforced)
`src/server/domain/lead-pipeline.ts` (pure, unit-tested) owns the transition map — `NEW → CONTACTED → QUALIFIED → ESTIMATE → WON`, any stage → `LOST` (reason required, enforced by the action AND the Zod schema), `WON`/`LOST` terminal. Illegal transitions → `ConflictError`; every change is audited `STATUS_CHANGED` with before/after + timestamps (`firstContactedAt`, `qualifiedAt`, `wonAt`, `lostAt`). The UI only offers allowed next statuses; the server is authoritative.

### Lead ↔ customer
- `attachCustomerToLead` links an existing customer (org-scope verified — Lead.customer is an id-only FK per the Slice 1 deviation).
- `convertWonLead` converts a WON lead into a customer (minimal per the slice brief): creates the Customer (deriving name from the lead title), links `lead.customerId`, audits Customer CREATE + Lead UPDATE in one transaction. The "first job placeholder" is deliberately deferred to Slice 5 (job creation needs a location + org-local jobNumber allocation).

### Actions (all in `features/*/server/`, all audited)
`createCustomer` / `updateCustomer` / `setCustomerActive` (CREATE/UPDATE/STATUS_CHANGED), `createLocation` / `updateLocation` / `deleteLocation` (CREATE/UPDATE/DELETE), `createLead` / `updateLead` / `updateLeadStatus` / `attachCustomerToLead` / `convertWonLead` (CREATE/UPDATE/STATUS_CHANGED). All return `ActionResult`; cross-tenant ids → `NotFoundError`.

### Tests
`tests/crm-schemas.test.ts` (customer/location/lead Zod valid+invalid), `tests/customer-duplicates.test.ts` (duplicate policy), `tests/lead-pipeline.test.ts` (transition map, LOST-requires-reason, timestamps). No live-DB/Clerk tests — those land in the verification pass.

**PENDING LIVE VERIFICATION** (all of Slice 3): `requirePermission()` depends on real Clerk keys and a provisioned org, so every page/action above is code-complete but unexercised at runtime; DB writes are untested until the verification pass.

## Slice 4 — Scheduling & calendar

The scheduling slice provides a tenant-scoped schedule at `/{orgSlug}/schedule`, protected by `SCHEDULE_READ`, with a lightweight custom calendar grid rather than a calendar dependency. Its URL-backed controls provide **day**, **week**, and **month** views, date navigation, and an active-technician filter; the visible UTC range is calculated from organization-local day boundaries before repositories query it.

### Appointment actions and permissions

- **Create** (`SCHEDULE_CREATE`) and **edit** (`SCHEDULE_UPDATE`) appointments through the shared RHF/Zod form. The form supports appointment type, assigned technicians, job/location links, travel buffers, notes, and an explicit IANA timezone.
- **Cancel** is a delete-like action guarded by `SCHEDULE_DELETE`. Status changes and **mark missed** are guarded by `SCHEDULE_UPDATE`.
- Every mutation validates input, re-checks the tenant-scoped target/related records, writes an audit entry in the mutation transaction, and returns a typed `ActionResult` for inline UI errors.

### Server-enforced status transition map

`TENTATIVE → CONFIRMED → EN_ROUTE → IN_PROGRESS → COMPLETED`. Cancellation is allowed from every non-terminal live status (`TENTATIVE`, `CONFIRMED`, `EN_ROUTE`, `IN_PROGRESS`); `MISSED` is allowed manually from `CONFIRMED`, `EN_ROUTE`, or `IN_PROGRESS`. `COMPLETED`, `MISSED`, and `CANCELLED` are terminal. The server owns this map and rejects invalid transitions; it also records first `IN_PROGRESS` as `actualStartAt`, `COMPLETED` as `actualEndAt`, and `MISSED` as `missedAt`.

### Conflict policy

On create and update, the server rejects an overlap for the **same technician**, using half-open `[start, end)` intervals expanded by each appointment's before/after travel buffers. The conflict message identifies the conflicting appointment. An overlap can proceed only when the caller explicitly sets `allowOverlap: true` **and** has effective `SCHEDULE_UPDATE` permission (the Dispatcher/Admin override); a create-only caller cannot bypass the policy.

### Timezone model

Appointment inputs are wall-clock `datetime-local` values plus an explicit IANA timezone, defaulting to the organization timezone. The server converts them to UTC for storage; calendar rendering converts stored UTC instants back to the organization-local timezone. The `src/lib/dates.ts` helpers calculate local midnights, ranges, and conversions in a DST-safe way, so visible days/ranges do not assume every local day has 24 hours.

**PENDING LIVE VERIFICATION:** the runtime schedule page and every appointment mutation remain session-gated until real Clerk credentials, a provisioned organization, and a live database are available. The code and unit tests cover the pure calendar/timezone, conflict, status-transition, and validation logic; live authorization, DB persistence, audit writes, and browser interaction still require that verification pass.

## Slice 5 — Jobs & dispatch workflow

The existing tenant-safe Job foundation now has server-rendered App Router screens at `/{orgSlug}/jobs`, `/jobs/new`, `/jobs/[jobId]`, and `/jobs/[jobId]/edit`. Every page derives tenant identity from `requirePermission()` (never from browser input), and every job/customer/location lookup flows through organization-bound repositories.

- The Jobs list is `JOB_READ`-gated and supports URL-backed **status** and **priority** filters, pagination, clear empty states, and job number/title/customer/location/type/priority/status/updated-time columns.
- Create is `JOB_CREATE`-gated; edit is `JOB_UPDATE`-gated. Their forms receive only the session tenant's customers and their locations, reset the selected location when the customer changes, and surface server validation/action errors. Repository validation remains the final backstop for the customer/location tuple.
- Detail is `JOB_READ`-gated and shows customer/location, job-level quoted/subtotal/tax/total/actual-revenue amounts, description, and lifecycle timestamps. Monetary form conversion and display use integer-cent helpers (no floating-point conversion). These values are **not invoices or payments**.
- Lifecycle controls render only when the current role has `JOB_STATUS_UPDATE`, and only expose the pure transition map's valid next state(s). `EN_ROUTE`, `IN_PROGRESS`, `ON_HOLD`, `COMPLETED`, and `CANCELLED` are reachable when their server-enforced predecessor rules allow; `setJobStatus` still independently authorizes, validates, checks tenancy, guards against stale writes, audits, and rejects invalid transitions.

- Dispatch assignment is `JOB_ASSIGN`-gated independently from job read/update. The tenant-scoped repository lists only active eligible technicians, rejects off-tenant IDs, and transactionally enforces **zero or one primary**: promoting/assigning a primary demotes the prior primary, while unassigning deletes the join so an unassigned technician cannot remain primary. Assignment, unassignment, and primary changes are audited.
- Job detail shows assigned technicians (including the explicit primary designation) and job-linked appointments. Roles without `JOB_ASSIGN` get a read-only assignment view; roles without `SCHEDULE_READ` do not receive appointment details. The **Schedule appointment** action uses the existing shared scheduler with a tenant-validated job and service-location prefill.
- Appointment creates/updates validate optional job links and require a job-linked appointment to use that job's in-tenant service location (and therefore its customer). Job-detail appointment reads are tenant-scoped and displayed with existing organization timezone utilities.

Invoices, payments, and billing workflows remain **Phase 2** work. Runtime authorization and database persistence remain PENDING LIVE VERIFICATION until Clerk keys, a provisioned organization, and a live database are configured; this README does not claim live Clerk or database verification.

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
  org shell, a real tenant-scoped KPI dashboard, and per-route `requirePermission` gates.
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
