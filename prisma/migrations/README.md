# prisma/migrations

No migrations exist yet — no live database is provisioned for this workspace.

Workflow when a database exists (see root README):

1. `DATABASE_URL=… bun run db:migrate` — `prisma migrate dev` (local dev, generates + applies).
2. `DATABASE_URL=… bun run db:deploy` — `prisma migrate deploy` (CI/deploy).
3. Never `prisma db push` on a shared database.
4. Review destructive migrations; commit every generated migration here.
