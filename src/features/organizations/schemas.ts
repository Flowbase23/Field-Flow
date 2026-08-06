/**
 * Zod schemas for organization settings + membership mutations (Slice 2 follow-up).
 *
 * Server actions validate their input with these schemas before touching any
 * repository; the client forms reuse the same schemas for instant feedback.
 * This module is intentionally PURE (zod + Intl only, no server-only imports)
 * so it can be bundled into client components safely.
 */
import { z } from "zod";

/** True if `tz` is a timezone Intl can resolve (IANA zone or legacy alias). */
export function isSupportedTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * True if `code` is a 3-letter uppercase ISO 4217 code. Uses
 * Intl.supportedValuesOf("currency") when the runtime provides it; falls back
 * to the shape check alone on runtimes without that API (e.g. some test envs).
 */
export function isSupportedCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: "currency") => string[] }
  ).supportedValuesOf?.("currency");
  return supported ? supported.includes(code) : true;
}

export const organizationNameSchema = z
  .string()
  .trim()
  .min(1, "Organization name is required.")
  .max(120, "Organization name must be 120 characters or fewer.");

export const timezoneSchema = z
  .string()
  .trim()
  .min(1, "Timezone is required.")
  .max(100, "Timezone must be 100 characters or fewer.")
  .refine(isSupportedTimezone, {
    message: "Enter a valid IANA timezone, e.g. America/New_York.",
  });

export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter ISO 4217 code, e.g. USD.")
  .refine(isSupportedCurrency, {
    message: "Currency must be a 3-letter ISO 4217 code, e.g. USD.",
  });

/** Organization settings update — slug is intentionally NOT editable. */
export const organizationUpdateSchema = z.object({
  name: organizationNameSchema,
  timezone: timezoneSchema,
  currency: currencySchema,
});
export type OrganizationUpdateInput = z.infer<typeof organizationUpdateSchema>;

/** Every app role, as string literals — matches the Prisma Role enum values. */
export const MEMBERSHIP_ROLES = [
  "OWNER",
  "ADMIN",
  "OFFICE_STAFF",
  "DISPATCHER",
  "TECHNICIAN",
  "SALES_REP",
  "CUSTOMER_PORTAL_USER",
] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const inviteMemberSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address.")
    .max(320, "Email must be 320 characters or fewer."),
  role: z.enum(MEMBERSHIP_ROLES),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const changeRoleSchema = z.object({
  membershipId: z.string().cuid("Invalid membership id."),
  role: z.enum(MEMBERSHIP_ROLES),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const setMemberActiveSchema = z.object({
  membershipId: z.string().cuid("Invalid membership id."),
  isActive: z.boolean(),
});
export type SetMemberActiveInput = z.infer<typeof setMemberActiveSchema>;

/** Common IANA zones for the settings form's datalist (any valid zone still works). */
export const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Zurich",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Australia/Perth",
  "Australia/Brisbane",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
] as const;
