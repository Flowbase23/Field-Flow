/**
 * Zod schemas for the CRM customer + location mutations (Phase 1, Slice 3).
 *
 * Server actions validate with these before touching any repository; the client
 * forms reuse them for instant feedback. This module is intentionally PURE
 * (zod + Intl only, no server-only imports, no @prisma/client runtime import —
 * enum values are declared as string literal arrays) so it can be bundled into
 * client components safely. The schemas mirror the shared builders in
 * src/lib/validation.ts (which additionally exposes nativeEnum schemas for
 * server-only use).
 */
import { z } from "zod";
import { isSupportedTimezone } from "@/features/organizations/schemas";

// ─── Shared field builders (pure — no Prisma runtime import) ─────────────────

export const optionalString = z
  .string()
  .trim()
  .max(500, "Must be 500 characters or fewer.")
  .optional()
  .nullable()
  .transform((v) => v || null);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .max(320, "Email must be 320 characters or fewer.")
  .optional()
  .nullable()
  .transform((v) => v || null);

/** Loose but safe phone validation: 7-20 chars of digits, spaces, + ( ) - . */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+().\-\s\d]{7,20}$/, "Enter a valid phone number.")
  .optional()
  .nullable()
  .transform((v) => v || null);

export const cuidSchema = z.string().cuid("Invalid id.");

/** Integer cents, non-negative — money is never stored as floats (design §3). */
export const centsSchema = z.number().int("Must be a whole number of cents.").nonnegative("Must be zero or more.").optional().nullable();

// ─── Customer ────────────────────────────────────────────────────────────────

/** CustomerType enum values as literals (matches the Prisma enum exactly). */
export const CUSTOMER_TYPES = ["RESIDENTIAL", "COMMERCIAL", "PROPERTY_MANAGER", "OTHER"] as const;
export const customerTypeSchema = z.enum(CUSTOMER_TYPES);

const customerFields = {
  firstName: optionalString,
  lastName: optionalString,
  companyName: optionalString,
  email: emailSchema,
  phone: phoneSchema,
  notes: optionalString,
} as const;

export const customerCreateSchema = z
  .object({
    ...customerFields,
    type: customerTypeSchema.default("RESIDENTIAL"),
  })
  .refine((v) => v.firstName || v.lastName || v.companyName, {
    message: "Provide at least a first name, last name, or company name.",
    path: ["firstName"],
  });

/** Update input — every field optional, NO defaults (absent = unchanged). */
export const customerUpdateSchema = z.object({ ...customerFields, type: customerTypeSchema.optional() }).partial();

/** Update action payload — id + optional fields. */
export const customerUpdateActionSchema = z.object({ id: cuidSchema, ...customerUpdateSchema.shape });

/** Activate/deactivate (soft delete) action payload. */
export const customerSetActiveSchema = z.object({ id: cuidSchema, isActive: z.boolean() });

export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;
export type CustomerUpdateActionInput = z.infer<typeof customerUpdateActionSchema>;
export type CustomerSetActiveInput = z.infer<typeof customerSetActiveSchema>;

// ─── Location ────────────────────────────────────────────────────────────────

/** Latitude/longitude ranges match the schema's Decimal(10,7) columns. */
export const latitudeSchema = z
  .number()
  .min(-90, "Latitude must be between -90 and 90.")
  .max(90, "Latitude must be between -90 and 90.")
  .optional()
  .nullable();
export const longitudeSchema = z
  .number()
  .min(-180, "Longitude must be between -180 and 180.")
  .max(180, "Longitude must be between -180 and 180.")
  .optional()
  .nullable();

// NOTE on update safety: these field schemas carry NO `.default()` — defaults
// are applied only in `locationCreateSchema` (zod's `.partial()` would otherwise
// re-apply a default on update when the key is absent, silently overwriting data).
const locationFields = {
  label: z.string().trim().min(1, "Label is required.").max(100, "Label must be 100 characters or fewer."),
  address1: z.string().trim().min(1, "Street address is required.").max(200, "Address must be 200 characters or fewer."),
  address2: optionalString,
  city: z.string().trim().min(1, "City is required.").max(100, "City must be 100 characters or fewer."),
  state: z.string().trim().min(1, "State is required.").max(50, "State must be 50 characters or fewer."),
  postalCode: z.string().trim().min(1, "Postal code is required.").max(20, "Postal code must be 20 characters or fewer."),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Country must be a 2-letter ISO 3166 code, e.g. US."),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  timezone: z
    .string()
    .trim()
    .max(100, "Timezone must be 100 characters or fewer.")
    .optional()
    .nullable()
    .refine((v) => v === null || v === undefined || v === "" || isSupportedTimezone(v), {
      message: "Enter a valid IANA timezone, e.g. America/New_York.",
    })
    .transform((v) => v || null),
  accessNotes: optionalString,
} as const;

const labelSchema = z.string().trim().min(1, "Label is required.").max(100, "Label must be 100 characters or fewer.");
const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Country must be a 2-letter ISO 3166 code, e.g. US.");

/** Location create input — customerId is added by the server action. */
export const locationCreateSchema = z.object({
  ...locationFields,
  label: labelSchema.default("Primary"),
  country: countrySchema.default("US"),
});

/** Location update — every field optional, NO defaults (absent = unchanged). */
export const locationUpdateSchema = z.object({ ...locationFields }).partial();

/** Location update action payload — id + optional fields. */
export const locationUpdateActionSchema = z.object({ id: cuidSchema, ...locationUpdateSchema.shape });

/** Location create action payload — customerId + fields. */
export const locationCreateActionSchema = z.object({ customerId: cuidSchema, ...locationCreateSchema.shape });

/** Location delete action payload. */
export const locationDeleteSchema = z.object({ id: cuidSchema });

export type LocationCreateInput = z.infer<typeof locationCreateSchema>;
export type LocationUpdateInput = z.infer<typeof locationUpdateSchema>;
export type LocationCreateActionInput = z.infer<typeof locationCreateActionSchema>;
export type LocationUpdateActionInput = z.infer<typeof locationUpdateActionSchema>;
export type LocationDeleteInput = z.infer<typeof locationDeleteSchema>;
