/**
 * Prisma seed — Phase 1 placeholder.
 *
 * Guarded by design §8.3 ("seed only with explicit env flag, known demo org id,
 * no slug-only seeding, dev-only destructive resets"): refuses to run unless
 * SEED_RUN=1 is set, and refuses to run against a non-local DATABASE_URL.
 *
 * Real fixtures (demo organization + members with known Clerk ids, sample
 * customers/locations) are added in Slice 2 (org bootstrap) once a database and
 * Clerk instance exist. Do not invent data here until the demo-org contract is
 * decided.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  if (process.env.SEED_RUN !== "1") {
    throw new Error("Refusing to seed: set SEED_RUN=1 to confirm this is intentional.");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost|127\.0\.0\.1|::1/.test(url)) {
    throw new Error(
      "Refusing to seed a non-local database. This seed is only safe against a local dev DB.",
    );
  }
  // Fixtures arrive with Slice 2 (org bootstrap). Deliberately nothing here yet.
  console.log("Seed guard passed. No fixtures defined until Slice 2.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
