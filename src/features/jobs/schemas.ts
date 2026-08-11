/**
 * Pure Zod contracts for the Phase 1 job domain. Tenant identity is deliberately
 * absent: it is always derived from requirePermission() on the server.
 */
import { z } from "zod";
import { centsSchema, cuidSchema, optionalString } from "@/features/customers/schemas";

export const JOB_TYPES = ["SERVICE_CALL", "INSTALLATION", "INSPECTION", "MAINTENANCE", "EMERGENCY", "WARRANTY"] as const;
export const JOB_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const JOB_STATUSES = ["DRAFT", "UNSCHEDULED", "SCHEDULED", "EN_ROUTE", "IN_PROGRESS", "ON_HOLD", "COMPLETED", "CANCELLED"] as const;

export const jobTypeSchema = z.enum(JOB_TYPES);
export const jobPrioritySchema = z.enum(JOB_PRIORITIES);
export const jobStatusSchema = z.enum(JOB_STATUSES);

const titleSchema = z.string().trim().min(1, "Title is required.").max(200, "Title must be 200 characters or fewer.");
const requiredCentsSchema = z.number().int("Must be a whole number of cents.").nonnegative("Must be zero or more.");

/** Fields that may be edited without changing job lifecycle status. */
const jobEditableFields = {
  title: titleSchema,
  type: jobTypeSchema,
  priority: jobPrioritySchema,
  customerId: cuidSchema,
  locationId: cuidSchema,
  leadId: cuidSchema.nullable().optional(),
  description: optionalString,
  quotedAmountCents: centsSchema,
  subtotalCents: requiredCentsSchema,
  taxCents: requiredCentsSchema,
  totalCents: requiredCentsSchema,
  actualRevenueCents: centsSchema,
} as const;

/** Create always begins in DRAFT; lifecycle changes use jobStatusUpdateSchema. */
export const jobCreateSchema = z.object({
  ...jobEditableFields,
  priority: jobPrioritySchema.default("NORMAL"),
  leadId: cuidSchema.nullable().default(null),
  description: optionalString.default(null),
  quotedAmountCents: centsSchema.default(null),
  subtotalCents: requiredCentsSchema.default(0),
  taxCents: requiredCentsSchema.default(0),
  totalCents: requiredCentsSchema.default(0),
  actualRevenueCents: centsSchema.default(null),
}).strict();

/** Partial edit has no defaults: an omitted property remains unchanged. */
export const jobUpdateSchema = z.object(jobEditableFields).partial().strict();
export const jobUpdateActionSchema = z.object({ id: cuidSchema, ...jobUpdateSchema.shape }).strict();
export const jobStatusUpdateSchema = z.object({ id: cuidSchema, status: jobStatusSchema }).strict();
export const jobReadSchema = z.object({ id: cuidSchema }).strict();

/** Dispatch assignment payloads; JOB_ASSIGN is enforced independently server-side. */
export const jobTechnicianAssignSchema = z.object({
  jobId: cuidSchema,
  technicianId: cuidSchema,
  isPrimary: z.boolean().optional().default(false),
}).strict();
export const jobTechnicianUnassignSchema = z.object({ jobId: cuidSchema, technicianId: cuidSchema }).strict();
export const jobTechnicianPrimarySchema = z.object({ jobId: cuidSchema, technicianId: cuidSchema }).strict();

export type JobCreateInput = z.infer<typeof jobCreateSchema>;
export type JobUpdateInput = z.infer<typeof jobUpdateSchema>;
export type JobUpdateActionInput = z.infer<typeof jobUpdateActionSchema>;
export type JobStatusUpdateInput = z.infer<typeof jobStatusUpdateSchema>;
export type JobTechnicianAssignInput = z.infer<typeof jobTechnicianAssignSchema>;
