/**
 * Zod contracts for the Phase 2 payment domain (Slice P2-3). Tenant identity is
 * deliberately absent: it is always derived from requirePermission() on the
 * server (or from verified Stripe webhook metadata). Pure module (zod + the
 * pure status lists from the domain module) so client forms can bundle it
 * safely.
 *
 * Money: `amountCents` arrives as a POSITIVE integer of cents — the client
 * parses its money inputs with src/lib/money.ts helpers. Status, ids, Stripe
 * identifiers and appliedAt are NEVER part of any payload: the schemas are
 * `.strict()`, so an injection attempt fails validation, and the repository
 * independently drops unknown fields.
 */
import { z } from "zod";
import { cuidSchema } from "@/features/customers/schemas";
import { PAYMENT_METHODS, PAYMENT_STATUSES } from "@/server/domain/payment-status";

export { PAYMENT_METHODS, PAYMENT_STATUSES };
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

const positiveCentsSchema = z
  .number({ message: "Enter the payment amount as dollars and cents." })
  .int("Must be a whole number of cents.")
  .positive("A payment must be more than zero.");

const optionalNotesSchema = z
  .string()
  .trim()
  .max(1000, "Keep notes under 1000 characters.")
  .nullable()
  .default(null);

/** Fields a user may set when recording a payment — everything else is system-set. */
export const paymentRecordSchema = z
  .object({
    invoiceId: cuidSchema,
    customerId: cuidSchema.nullable().default(null),
    amountCents: positiveCentsSchema,
    method: paymentMethodSchema,
    notes: optionalNotesSchema,
  })
  .strict();

export const paymentReadSchema = z.object({ id: cuidSchema }).strict();
export const paymentVoidSchema = z.object({ id: cuidSchema }).strict();
export const paymentRefundSchema = z.object({ id: cuidSchema }).strict();
/** Stripe checkout: the invoice is the only input; the amount is its balance. */
export const paymentStripeCheckoutSchema = z.object({ invoiceId: cuidSchema }).strict();

/** Server action list payload (getPayments). */
export const paymentListActionSchema = z
  .object({
    status: paymentStatusSchema.optional(),
    method: paymentMethodSchema.optional(),
    invoiceId: cuidSchema.optional(),
    customerId: cuidSchema.optional(),
    page: z.number().int().min(1).max(10000).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
  })
  .strict();

export type PaymentRecordInput = z.infer<typeof paymentRecordSchema>;
export type PaymentListActionInput = z.infer<typeof paymentListActionSchema>;
