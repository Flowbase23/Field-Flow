/**
 * Prisma client singleton.
 *
 * One PrismaClient per process (dev hot-reload safe). The client connects lazily,
 * so importing this module never touches the database — required for `next build`
 * to succeed without a DATABASE_URL. Never import PrismaClient directly anywhere
 * else; use this singleton and the tenant-scoped wrappers in src/server/db.
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
