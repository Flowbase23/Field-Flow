/**
 * Zod contracts for the Phase 2 estimate domain (Slice P2-2). Tenant identity is
 * deliberately absent: it is always derived from requirePermission() on the
 * server. Pure module (zod + the pure status lists from the domain module) so
 * client forms can bundle it safely.
 *
 * Money: subtotal/tax arrive as integer cents — the client parses its money
 * inputs with src/lib/money.ts helpers. totalCents is NEVER part of any
 * payload; the repository recomputes it server-side.
 *
 * Dates: forms send plain `YYYY-MM-DD` strings; the schema transforms them to
 * UTC-midnight Date objects before they reach the repository. EXPIRED is a
 * derived display/filter value only and never a settable status.
 */
import { z } from "zod";
import { cuidSchema } from "@/features/customers/schemas";
import {
  ESTIMATE_SETTABLE_STATUSES,
  ESTIMATE_STATUSES,
  ESTIMATE_DISPLAY_STATUSES,
} from "@/server/domain/estimate-status";

export { ESTIMATE_STATUSES, ESTIMATE_SETTABLE_STATUSES, ESTIMATE_DISPLAY_STATUSES };
/** Five statuses plus the DERIVED EXPIRED (list filter/display only). */
export const estimateStatusSchema = z.enum(ESTIMATE_DISPLAY_STATUSES);
/** Statuses a user may request — EXPIRED is derived on read, never settable. */
export const estimateSettableStatusSchema = z.enum(ESTIMATE_SETTABLE_STATUSES);

const requiredCentsSchema = z.number().int("Must be a whole number of cents.").nonnegative("Must be zero or more.");
const optionalDateStringSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker (YYYY-MM-DD).")
  .optional()
  .nullable()
  .transform((value) => (value ? new Date(`${value}T00:00:00.000Z`) : null));
const optionalTitleSchema = z
  .string()
  .trim()
  .max(200, "Keep the title under 200 characters.")
  .optional()
  .nullable()
  .transform((value) => (value && value.length > 0 ? value : null));

/** Fields shared by the create and edit forms (full-replacement edit semantics). */
const estimateFormFields = {
  customerId: cuidSchema,
  jobId: cuidSchema.nullable(),
  title: optionalTitleSchema,
  validUntil: optionalDateStringSchema,
  subtotalCents: requiredCentsSchema,
  taxCents: requiredCentsSchema,
} as const;

/** Create always begins in DRAFT; the total is computed server-side. */
export const estimateCreateSchema = z
  .object({
    ...estimateFormFields,
    jobId: cuidSchema.nullable().default(null),
    title: optionalTitleSchema.default(null),
    validUntil: optionalDateStringSchema.default(null),
    subtotalCents: requiredCentsSchema.default(0),
    taxCents: requiredCentsSchema.default(0),
  })
  .strict();

/**
 * Edit form payload: the form always sends the complete editable field set
 * (like the invoice form), so `null` clears an optional field and omitted keys
 * are not a supported edit path. Status/lifecycle stamps/numbers are not
 * editable here.
 */
export const estimateUpdateSchema = z.object(estimateFormFields).strict();
export const estimateUpdateActionSchema = z.object({ id: cuidSchema, ...estimateUpdateSchema.shape }).strict();
export const estimateStatusUpdateSchema = z.object({ id: cuidSchema, status: estimateSettableStatusSchema }).strict();
export const estimateReadSchema = z.object({ id: cuidSchema }).strict();
/**
 * Convert-to-job payload: the estimate id is the ONLY client-supplied value.
 * Every job field (number, customer, location, money, title) is derived
 * server-side by the job repository's createFromEstimate, so there is nothing
 * else to validate or inject here.
 */
export const estimateConvertSchema = z.object({ id: cuidSchema }).strict();

export type EstimateCreateInput = z.infer<typeof estimateCreateSchema>;
export type EstimateUpdateInput = z.infer<typeof estimateUpdateSchema>;
export type EstimateUpdateActionInput = z.infer<typeof estimateUpdateActionSchema>;
export type EstimateStatusUpdateInput = z.infer<typeof estimateStatusUpdateSchema>;
export type EstimateConvertInput = z.infer<typeof estimateConvertSchema>;
