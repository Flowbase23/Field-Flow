/**
 * Zod schemas for schedule mutations (Phase 1, Slice 4).
 *
 * Server actions validate with these before touching any repository; the client
 * forms reuse them (RHF + zodResolver) for instant feedback. This module is
 * intentionally PURE (zod + Intl only, no server-only imports, no @prisma/client
 * runtime import — enum values are string literal arrays) so it can be bundled
 * into client components safely.
 *
 * Timezone model (design §8.2, documented in the README): the client sends
 * startsAt/endsAt as WALL-CLOCK datetimes ("YYYY-MM-DDTHH:mm", the value of an
 * <input type="datetime-local">) plus an explicit IANA `timezone` (defaults to
 * the org timezone server-side). The server converts to UTC for storage with
 * localDateTimeToUtc; display converts back. NEVER send UTC strings or offsets.
 */
import { z } from "zod";
import { isSupportedTimezone } from "@/features/organizations/schemas";
import { cuidSchema, optionalString } from "@/features/customers/schemas";

// ─── Enum values (match the Prisma enums exactly) ────────────────────────────

export const APPOINTMENT_STATUSES = [
  "TENTATIVE",
  "CONFIRMED",
  "EN_ROUTE",
  "IN_PROGRESS",
  "COMPLETED",
  "MISSED",
  "CANCELLED",
] as const;
export const appointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);

export const APPOINTMENT_TYPES = ["JOB", "BLOCKED_TIME", "TRAVEL", "OTHER"] as const;
export const appointmentTypeSchema = z.enum(APPOINTMENT_TYPES);

// ─── Shared field builders ───────────────────────────────────────────────────

/** Wall-clock "YYYY-MM-DDTHH:mm" (datetime-local value), no timezone component. */
export const localDateTimeSchema = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    "Enter a date and time, e.g. 2026-08-05T09:30.",
  );

/** IANA timezone; must be resolvable by Intl (org timezone applied server-side when absent). */
export const timezoneSchema = z
  .string()
  .trim()
  .min(1, "Timezone is required.")
  .max(100, "Timezone must be 100 characters or fewer.")
  .refine(isSupportedTimezone, {
    message: "Enter a valid IANA timezone, e.g. America/New_York.",
  });

/** Travel time in whole minutes (0–12h). */
const travelMinutesSchema = z
  .number()
  .int("Travel time must be a whole number of minutes.")
  .min(0, "Travel time cannot be negative.")
  .max(720, "Travel time must be 12 hours or fewer.");

const technicianIdsSchema = z
  .array(cuidSchema)
  .max(50, "An appointment can involve at most 50 technicians.");

/**
 * Shared create fields. NOTE: NO `.default()` for travelMinutes — defaults are
 * applied only in the create schema so an update cannot silently overwrite
 * stored values when the key is absent.
 */
const appointmentFields = {
  title: z.string().trim().min(1, "Title is required.").max(200, "Title must be 200 characters or fewer."),
  type: appointmentTypeSchema,
  startsAt: localDateTimeSchema,
  endsAt: localDateTimeSchema,
  timezone: timezoneSchema,
  technicianIds: technicianIdsSchema,
  jobId: cuidSchema.optional().nullable(),
  locationId: cuidSchema.optional().nullable(),
  travelMinutesBefore: travelMinutesSchema.optional(),
  travelMinutesAfter: travelMinutesSchema.optional(),
  notes: optionalString,
  /** Dispatcher/Admin override — server requires SCHEDULE_UPDATE to honor it. */
  allowOverlap: z.boolean().optional(),
} as const;

export const appointmentCreateSchema = z.object(appointmentFields).refine((v) => v.endsAt > v.startsAt, {
  message: "End time must be after the start time.",
  path: ["endsAt"],
});

/** Update input — every field optional, NO defaults (absent = unchanged). */
export const appointmentUpdateSchema = z.object(appointmentFields).partial();

/** Update action payload — id + optional fields. */
export const appointmentUpdateActionSchema = z.object({ id: cuidSchema, ...appointmentUpdateSchema.shape });

/** Create action payload — createdByUserId is set server-side from the session. */
export const appointmentCreateActionSchema = appointmentCreateSchema;

/** Status transition action payload (setAppointmentStatus). */
export const appointmentSetStatusSchema = z.object({
  id: cuidSchema,
  status: appointmentStatusSchema,
});

/** Cancel action payload. */
export const appointmentCancelSchema = z.object({ id: cuidSchema });

/** Mark-missed action payload. */
export const appointmentMarkMissedSchema = z.object({ id: cuidSchema });

export type AppointmentCreateInput = z.infer<typeof appointmentCreateSchema>;
export type AppointmentUpdateInput = z.infer<typeof appointmentUpdateSchema>;
export type AppointmentUpdateActionInput = z.infer<typeof appointmentUpdateActionSchema>;
export type AppointmentSetStatusInput = z.infer<typeof appointmentSetStatusSchema>;
