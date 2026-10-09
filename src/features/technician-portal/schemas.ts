/**
 * Zod contracts for the technician portal (Phase 2 Slice P2-S5). Tenant identity
 * is deliberately absent: it is always derived from requirePermission() on the
 * server, and the technician id is ALWAYS resolved server-side from the session
 * user (never accepted from the client — the schemas have no technicianId field
 * at all). Pure module (zod only) so client forms can bundle it safely.
 *
 * Time entry input (decision documented in the slice PR): the technician enters
 * a work date and either manual HOURS or an optional start/end wall-clock pair.
 * When a full span is given, the duration is derived server-side and any hours
 * value is ignored — the stored minutes are always server-computed. The DB
 * column is `minutes` (integer minutes); hours are accepted as decimal hours
 * (e.g. 1.5) and converted with whole-minute rounding.
 */
import { z } from "zod";
import { cuidSchema } from "@/features/customers/schemas";

/** Work date as a wall-clock YYYY-MM-DD in the organization timezone. */
const workDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date (YYYY-MM-DD).");

/** Optional wall-clock times (HH:mm, 24h) in the organization timezone. */
const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a HH:MM 24-hour time.");

/** Decimal hours for a single entry — positive, at most a full day. */
const hoursSchema = z
  .number({ message: "Enter the hours worked." })
  .positive("Hours must be greater than zero.")
  .max(24, "A single entry cannot exceed 24 hours.");

export const timeEntryCreateSchema = z
  .object({
    /** Optional job link; validated (tenant + assignment) server-side. */
    jobId: cuidSchema.nullable().default(null),
    workDate: workDateSchema,
    hours: hoursSchema.optional(),
    startTime: timeOfDaySchema.optional(),
    endTime: timeOfDaySchema.optional(),
    billable: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fullSpan = Boolean(value.startTime && value.endTime);
    if (value.hours === undefined && !fullSpan) {
      ctx.addIssue({ code: "custom", path: ["hours"], message: "Enter hours, or a start and an end time." });
    }
    if ((value.startTime && !value.endTime) || (!value.startTime && value.endTime)) {
      ctx.addIssue({ code: "custom", path: ["endTime"], message: "Provide both a start and an end time." });
    }
  });

export type TimeEntryCreateInput = z.infer<typeof timeEntryCreateSchema>;
