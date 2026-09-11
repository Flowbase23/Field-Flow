# prisma/migrations

`20260805225341_init/` — the initial full Phase 1 schema. It is **applied** to
the provisioned Neon Postgres: `DATABASE_URL=… bunx prisma migrate status`
reports the schema up to date. That is a schema-level fact only — application
runtime writes against this database remain PENDING LIVE VERIFICATION
(`docs/runbook.md` §7).

Workflow:

1. `DATABASE_URL=… bunx prisma migrate dev` — local dev, creates + applies a
   migration (and regenerates the client).
2. `DATABASE_URL=… bunx prisma migrate deploy` — CI/deploy, applies pending
   migrations.
3. **Never `prisma db push` on a shared database.**
4. Review destructive migrations; commit every generated migration here with
   the change that introduced it.
