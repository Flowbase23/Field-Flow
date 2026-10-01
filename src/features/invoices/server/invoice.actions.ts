/**
 * Invoice server actions — Phase 2 Slice P2-1. Organization identity comes
 * solely from Clerk-backed requirePermission(); the browser payloads have no
 * organizationId field. Each mutation and its audit row share one database
 * transaction, and Invoices are reached only through the tenant-scoped repo.
 */
"use server";
import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { actionError, NotFoundError, type ActionResult } from "@/lib/errors";
import { toAuditJson, writeAuditLog } from "@/server/audit";
import { requirePermission } from "@/server/auth/require-org";
import { db } from "@/server/db/client";
import { createInvoiceRepo } from "@/server/repositories/invoice.repo";
import {
  invoiceCreateSchema,
  invoiceReadSchema,
  invoiceStatusUpdateSchema,
  invoiceUpdateActionSchema,
} from "../schemas";

export interface InvoiceActionResult {
  id: string;
  invoiceNumber: number;
  status: string;
  totalCents: number;
  balanceCents: number;
}
interface InvoiceSnapshotFields {
  invoiceNumber?: number;
  customerId: string;
  jobId: string | null;
  status: string;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}
function invoiceSnapshot(invoice: InvoiceSnapshotFields) {
  return {
    invoiceNumber: invoice.invoiceNumber,
    customerId: invoice.customerId,
    jobId: invoice.jobId,
    status: invoice.status,
    issuedAt: invoice.issuedAt?.toISOString() ?? null,
    dueAt: invoice.dueAt?.toISOString() ?? null,
    paidAt: invoice.paidAt?.toISOString() ?? null,
    subtotalCents: invoice.subtotalCents,
    taxCents: invoice.taxCents,
    totalCents: invoice.totalCents,
    paidCents: invoice.paidCents,
    balanceCents: invoice.balanceCents,
  };
}
function revalidateInvoices(orgSlug: string, invoiceId?: string): void {
  revalidatePath(`/${orgSlug}/invoices`);
  if (invoiceId) revalidatePath(`/${orgSlug}/invoices/${invoiceId}`);
}
/** Tenant-scoped read primitive. INVOICE_READ is enforced independently of any UI. */
export async function getInvoice(input: unknown): Promise<ActionResult<InvoiceActionResult>> {
  try {
    const ctx = await requirePermission(Permission.INVOICE_READ);
    const { id } = invoiceReadSchema.parse(input);
    const invoice = await createInvoiceRepo(db, ctx.organizationId).getById(id);
    if (!invoice) throw new NotFoundError("Invoice not found in this organization.");
    return {
      ok: true,
      data: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        totalCents: invoice.totalCents,
        balanceCents: invoice.balanceCents,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}
/** Create in DRAFT with an atomic org-local invoice number and CREATE audit record. */
export async function createInvoice(input: unknown): Promise<ActionResult<InvoiceActionResult>> {
  try {
    const ctx = await requirePermission(Permission.INVOICE_CREATE);
    const data = invoiceCreateSchema.parse(input);
    const created = await db.$transaction(async (tx) => {
      const invoice = await createInvoiceRepo(tx, ctx.organizationId).create(data);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.CREATE,
          entityType: "Invoice",
          entityId: invoice.id,
          before: toAuditJson(null),
          after: toAuditJson(invoiceSnapshot(invoice)),
          metadata: toAuditJson({
            requested: {
              customerId: data.customerId,
              jobId: data.jobId,
              issuedAt: data.issuedAt?.toISOString() ?? null,
              dueAt: data.dueAt?.toISOString() ?? null,
              subtotalCents: data.subtotalCents,
              taxCents: data.taxCents,
            },
          }),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      return invoice;
    });
    revalidateInvoices(ctx.organization.slug, created.id);
    return {
      ok: true,
      data: {
        id: created.id,
        invoiceNumber: created.invoiceNumber,
        status: created.status,
        totalCents: created.totalCents,
        balanceCents: created.balanceCents,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}
/** Edit customer/job/dates/subtotal/tax; the repo recomputes totals server-side. */
export async function updateInvoice(input: unknown): Promise<ActionResult<InvoiceActionResult>> {
  try {
    const ctx = await requirePermission(Permission.INVOICE_UPDATE);
    const { id, ...data } = invoiceUpdateActionSchema.parse(input);
    const updated = await db.$transaction(async (tx) => {
      const repo = createInvoiceRepo(tx, ctx.organizationId);
      const existing = await repo.getById(id);
      if (!existing) throw new NotFoundError("Invoice not found in this organization.");
      const updated = await repo.update(id, data);
      await writeAuditLog(
        {
          organizationId: ctx.organizationId,
          action: AuditAction.UPDATE,
          entityType: "Invoice",
          entityId: id,
          before: toAuditJson(invoiceSnapshot(existing)),
          after: toAuditJson(invoiceSnapshot(updated)),
          actorUserId: ctx.userId,
          actorClerkUserId: ctx.clerkUserId,
        },
        tx,
      );
      return updated;
    });
    revalidateInvoices(ctx.organization.slug, updated.id);
    return {
      ok: true,
      data: {
        id: updated.id,
        invoiceNumber: updated.invoiceNumber,
        status: updated.status,
        totalCents: updated.totalCents,
        balanceCents: updated.balanceCents,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}
/** Server-enforced lifecycle transition; only this action writes Invoice.status. */
export async function setInvoiceStatus(input: unknown): Promise<ActionResult<InvoiceActionResult>> {
  try {
    const ctx = await requirePermission(Permission.INVOICE_STATUS_UPDATE);
    const { id, status } = invoiceStatusUpdateSchema.parse(input);
    const result = await db.$transaction(async (tx) => {
      const repo = createInvoiceRepo(tx, ctx.organizationId);
      const existing = await repo.getById(id);
      if (!existing) throw new NotFoundError("Invoice not found in this organization.");
      const updated = await repo.setStatus(id, status);
      const changed = updated.status !== existing.status;
      if (changed) {
        await writeAuditLog(
          {
            organizationId: ctx.organizationId,
            action: AuditAction.STATUS_CHANGED,
            entityType: "Invoice",
            entityId: id,
            before: toAuditJson(invoiceSnapshot(existing)),
            after: toAuditJson(invoiceSnapshot(updated)),
            actorUserId: ctx.userId,
            actorClerkUserId: ctx.clerkUserId,
          },
          tx,
        );
      }
      return { changed, invoice: updated };
    });
    if (result.changed) revalidateInvoices(ctx.organization.slug, result.invoice.id);
    return {
      ok: true,
      data: {
        id: result.invoice.id,
        invoiceNumber: result.invoice.invoiceNumber,
        status: result.invoice.status,
        totalCents: result.invoice.totalCents,
        balanceCents: result.invoice.balanceCents,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}
