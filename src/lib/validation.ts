/**
 * Zod validation schemas shared by server actions and client forms.
 *
 * These are the Slice-3-ready schemas for the CRM (customers, leads); the first
 * slices ship the auth/tenant foundation, so nothing calls them yet. Every server
 * action in later slices MUST validate its input with a Zod schema here (or in the
 * owning feature module) before touching a repository — never trust raw input.
 */
import { z } from "zod";
import { CustomerType, LeadSource } from "@prisma/client";

export const optionalString = z
  .string()
  .trim()
  .max(500)
  .optional()
  .nullable()
  .transform((v) => v || null);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .max(320)
  .optional()
  .nullable()
  .transform((v) => v || null);

/** Loose but safe phone validation: 7-20 chars of digits, spaces, + ( ) - . */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+()\-.\s\d]{7,20}$/, "Enter a valid phone number.")
  .optional()
  .nullable()
  .transform((v) => v || null);

/** Cents as a non-negative integer. */
export const centsSchema = z.number().int().nonnegative().optional().nullable();

export const customerCreateSchema = z
  .object({
    firstName: optionalString,
    lastName: optionalString,
    companyName: optionalString,
    email: emailSchema,
    phone: phoneSchema,
    type: z.nativeEnum(CustomerType).default(CustomerType.RESIDENTIAL),
    notes: optionalString,
  })
  .refine((v) => v.firstName || v.lastName || v.companyName, {
    message: "Provide at least a first name, last name, or company name.",
    path: ["firstName"],
  });

export const customerUpdateSchema = customerCreateSchema.partial();

export const leadCreateSchema = z.object({
  customerId: z.string().cuid().optional().nullable(),
  ownerUserId: z.string().cuid().optional().nullable(),
  source: z.nativeEnum(LeadSource).default(LeadSource.OTHER),
  title: z.string().trim().min(1, "Title is required.").max(300),
  description: optionalString,
  estimatedValueCents: centsSchema,
});

export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;
export type LeadCreateInput = z.infer<typeof leadCreateSchema>;
