/**
 * Zod schemas for lead mutations (Phase 1, Slice 3).
 *
 * Same conventions as features/customers/schemas.ts: PURE module (zod only,
 * no @prisma/client runtime import — enums are string literal arrays) so client
 * forms can import it; server actions validate with it before touching a repo.
 * The transition rules themselves live in src/server/domain/lead-pipeline.ts
 * (unit-tested); this module additionally refines status-change input so a LOST
 * transition carries a reason at the validation boundary (defense in depth).
 */
import { z } from "zod";
import { cuidSchema, emailSchema, optionalString, phoneSchema } from "@/features/customers/schemas";

/** LeadStatus enum values (schema order) — mirrors server/domain/lead-pipeline.ts. */
export const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATE", "WON", "LOST"] as const;
export const leadStatusSchema = z.enum(LEAD_STATUSES);

/** LeadSource enum values (schema order). */
export const LEAD_SOURCES = ["WEBSITE", "PHONE", "REFERRAL", "ADVERTISEMENT", "REPEAT_CUSTOMER", "PARTNER", "OTHER"] as const;
export const leadSourceSchema = z.enum(LEAD_SOURCES);

/** Non-negative integer cents — money is never stored as floats (design §3). Absent → null. */
export const estimatedValueCentsSchema = z
  .number()
  .int("Estimated value must be a whole number of cents.")
  .nonnegative("Estimated value must be zero or more.")
  .nullable()
  .default(null);

/** Fields shared by create + update (NO defaults here — update safety). */
const leadFields = {
  title: z.string().trim().min(1, "Title is required.").max(300, "Title must be 300 characters or fewer."),
  description: optionalString,
  estimatedValueCents: estimatedValueCentsSchema,
  /** Local User.id of the assigned sales rep — must be an org member (checked in the action). */
  ownerUserId: cuidSchema.nullable().default(null),
  /** Optional link to an existing customer — must belong to the org (checked in the action). */
  customerId: cuidSchema.nullable().default(null),
} as const;

export const leadCreateSchema = z.object({
  ...leadFields,
  source: leadSourceSchema.default("OTHER"),
  status: leadStatusSchema.default("NEW"),
});

/** Full edit — every field optional, NO defaults (absent = unchanged). */
export const leadUpdateSchema = z.object({ ...leadFields, source: leadSourceSchema.optional() }).partial();

/** Update action payload — id + optional fields. */
export const leadUpdateActionSchema = z.object({ id: cuidSchema, ...leadUpdateSchema.shape });

/**
 * Status-change action payload. Super-refine enforces the LOST → lostReason
 * rule at the boundary; the pipeline module enforces it again on the server.
 */
export const leadStatusUpdateSchema = z
  .object({
    id: cuidSchema,
    status: leadStatusSchema,
    lostReason: z.string().trim().min(1, "A reason is required to mark a lead as lost.").max(500, "Reason must be 500 characters or fewer.").optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "LOST" && !value.lostReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lostReason"],
        message: "A reason is required to mark a lead as lost.",
      });
    }
  });

/** Attach an existing customer to a lead. */
export const leadAttachCustomerSchema = z.object({
  id: cuidSchema,
  customerId: cuidSchema,
});

/**
 * Convert a WON lead into a customer. `customer` is optional: when omitted (or
 * partially filled) the action derives defaults from the lead (see the action).
 */
export const leadConvertSchema = z.object({
  id: cuidSchema,
  customer: z
    .object({
      firstName: optionalString,
      lastName: optionalString,
      companyName: optionalString,
      email: emailSchema,
      phone: phoneSchema,
      type: z.enum(["RESIDENTIAL", "COMMERCIAL", "PROPERTY_MANAGER", "OTHER"]).optional(),
      notes: optionalString,
    })
    .optional(),
});

export type LeadCreateInput = z.infer<typeof leadCreateSchema>;
export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;
export type LeadUpdateActionInput = z.infer<typeof leadUpdateActionSchema>;
export type LeadStatusUpdateInput = z.infer<typeof leadStatusUpdateSchema>;
export type LeadAttachCustomerInput = z.infer<typeof leadAttachCustomerSchema>;
export type LeadConvertInput = z.infer<typeof leadConvertSchema>;
