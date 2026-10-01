/**
 * Zod contracts for the Phase 2 invoice domain (Slice P2-1). Tenant identity is
 * deliberately absent: it is always derived from requirePermission() on the
 * server. Pure module (zod + the pure status lists from the domain module) so
 * client forms can bundle it safely.
 *
 * Money: subtotal/tax arrive as integer cents — the client parses its money
 * inputs with src/lib/money.ts helpers. totalCents/balanceCents are NEVER part
 * of any payload; the repository recomputes them server-side.
 *
 * Dates: forms send plain `YYYY-MM-DD` strings; the schema transforms them to
 * UTC-midnight Date objects before they reach the repository.
 */
import { z } from "zod";
import { cuidSchema } from "@/features/customers/schemas";
import { INVOICE_SETTABLE_STATUSES, INVOICE_STATUSES } from "@/server/domain/invoice-status";

export { INVOICE_STATUSES, INVOICE_SETTABLE_STATUSES };
/** Six statuses including the DERIVED OVERDUE (list filter/display only). */
export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);
/** Statuses a user may request — OVERDUE is derived on read, never settable. */
export const invoiceSettableStatusSchema = z.enum(INVOICE_SETTABLE_STATUSES);

const requiredCentsSchema = z.number().int("Must be a whole number of cents.").nonnegative("Must be zero or more.");
const optionalDateStringSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker (YYYY-MM-DD).")
  .optional()
  .nullable()
  .transform((value) => (value ? new Date(`${value}T00:00:00.000Z`) : null));

/** Fields shared by the create and edit forms (full-replacement edit semantics). */
const invoiceFormFields = {
  customerId: cuidSchema,
  jobId: cuidSchema.nullable(),
  issuedAt: optionalDateStringSchema,
  dueAt: optionalDateStringSchema,
  subtotalCents: requiredCentsSchema,
  taxCents: requiredCentsSchema,
} as const;

/** Create always begins in DRAFT; totals are computed server-side. */
export const invoiceCreateSchema = z
  .object({
    ...invoiceFormFields,
    jobId: cuidSchema.nullable().default(null),
    issuedAt: optionalDateStringSchema.default(null),
    dueAt: optionalDateStringSchema.default(null),
    subtotalCents: requiredCentsSchema.default(0),
    taxCents: requiredCentsSchema.default(0),
  })
  .strict();

/**
 * Edit form payload: the form always sends the complete editable field set
 * (like the job form), so `null` clears an optional field and omitted keys are
 * not a supported edit path. Status/paid amounts/numbers are not editable here.
 */
export const invoiceUpdateSchema = z.object(invoiceFormFields).strict();
export const invoiceUpdateActionSchema = z.object({ id: cuidSchema, ...invoiceUpdateSchema.shape }).strict();
export const invoiceStatusUpdateSchema = z.object({ id: cuidSchema, status: invoiceSettableStatusSchema }).strict();
export const invoiceReadSchema = z.object({ id: cuidSchema }).strict();

export type InvoiceCreateInput = z.infer<typeof invoiceCreateSchema>;
export type InvoiceUpdateInput = z.infer<typeof invoiceUpdateSchema>;
export type InvoiceUpdateActionInput = z.infer<typeof invoiceUpdateActionSchema>;
export type InvoiceStatusUpdateInput = z.infer<typeof invoiceStatusUpdateSchema>;
