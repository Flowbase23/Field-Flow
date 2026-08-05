/**
 * Audit logging (design §1 mechanism E, §8.5).
 *
 * AuditLog is APPEND-ONLY: nothing in the application ever updates or deletes
 * audit rows (the schema documents this too). Every authorization-sensitive
 * action (role changes, membership changes, status transitions, exports, invites,
 * delete-like operations) MUST write an AuditLog entry. Use `withAudit` to wrap a
 * mutation so the row is written in the SAME transaction as the change.
 *
 * before/after are JSON snapshots of the affected record (use `toAuditJson`;
 * Dates → ISO strings, undefined dropped, BigInt → string).
 */
import type { AuditAction, Prisma } from "@prisma/client";
import { db } from "@/server/db/client";

export interface AuditLogInput {
  organizationId: string;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  metadata?: Prisma.InputJsonValue | null;
  actorUserId?: string | null;
  actorClerkUserId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

type Tx = Prisma.TransactionClient | Prisma.PrismaClient;

/** JSON-encode an arbitrary value for storage in a Json column. */
export function toAuditJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return (value ?? null) as Prisma.InputJsonValue;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => toAuditJson(v)) as unknown as Prisma.InputJsonValue;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = toAuditJson(v);
    }
    return out as Prisma.InputJsonValue;
  }
  return String(value) as Prisma.InputJsonValue;
}

/** Write an audit row on the given client (defaults to the global db). */
export async function writeAuditLog(input: AuditLogInput, tx: Tx = db): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      metadata: input.metadata ?? null,
      actorUserId: input.actorUserId ?? null,
      actorClerkUserId: input.actorClerkUserId ?? null,
      requestId: input.requestId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

export interface WithAuditOptions {
  organizationId: string;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  actorUserId?: string | null;
  actorClerkUserId?: string | null;
}

/**
 * Run `fn` and write the audit row in the same transaction. `before`/`after`
 * are JSON-encoded via toAuditJson. Usage:
 *
 *   const result = await withAudit({ organizationId, action: AuditAction.UPDATE,
 *     entityType: "Customer", entityId: id, before: prev, after: next, actorUserId: userId },
 *     (tx) => tx.customer.update({ ... }));
 */
export async function withAudit<T>(
  options: WithAuditOptions,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const result = await fn(tx);
    await writeAuditLog(
      {
        organizationId: options.organizationId,
        action: options.action,
        entityType: options.entityType,
        entityId: options.entityId,
        before: toAuditJson(options.before),
        after: toAuditJson(options.after),
        metadata: toAuditJson(options.metadata),
        actorUserId: options.actorUserId,
        actorClerkUserId: options.actorClerkUserId,
      },
      tx,
    );
    return result;
  });
}
