/**
 * Lead pipeline — server-enforced status transitions (design §3:
 * "Status transitions must be server-enforced (map of allowed transitions per
 * status), run in a transaction, and audited").
 *
 * This module is PURE (no DB, no server-only imports) so it can be unit-tested
 * in isolation and imported by server actions, pages and (through the const
 * arrays) client components without dragging server code into the bundle.
 *
 * Pipeline (forward-only, terminal at WON/LOST):
 *
 *   NEW → CONTACTED → QUALIFIED → ESTIMATE → WON
 *    │      │           │           │
 *    └──────┴───────┬───┴───────┬───┘
 *                   ↓           ↓
 *                  LOST        LOST
 *
 * LOST always requires a `lostReason` (enforced here AND by the Zod schema in
 * features/leads/schemas.ts — defense in depth). WON and LOST are terminal:
 * once a lead is won or lost it cannot move again (re-opening a lost lead is a
 * product decision for a later slice).
 *
 * Timestamp bookkeeping: the first time a lead reaches a pipeline stage we
 * record it (firstContactedAt / qualifiedAt / wonAt / lostAt) — these feed the
 * dashboard's lead-conversion cohort later.
 */
import { ConflictError, ValidationError } from "@/lib/errors";
import type { LeadStatus } from "@prisma/client";

/** All LeadStatus enum values, in schema order — shared with the Zod schema. */
export const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATE", "WON", "LOST"] as const;

/**
 * Allowed forward transitions keyed by current status. WON and LOST are
 * terminal (empty arrays). Same-status updates are handled as no-ops by callers.
 */
export const LEAD_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW: ["CONTACTED", "LOST"],
  CONTACTED: ["QUALIFIED", "LOST"],
  QUALIFIED: ["ESTIMATE", "LOST"],
  ESTIMATE: ["WON", "LOST"],
  WON: [],
  LOST: [],
};

export function canTransitionLead(from: LeadStatus, to: LeadStatus): boolean {
  return LEAD_TRANSITIONS[from].includes(to);
}

/** LOST is the only status that requires an explanation. */
export function transitionRequiresLostReason(to: LeadStatus): boolean {
  return to === "LOST";
}

/** Timestamp/lostReason fields that change when a lead reaches a stage. */
export interface LeadTransitionFields {
  firstContactedAt?: Date;
  qualifiedAt?: Date;
  wonAt?: Date;
  lostAt?: Date;
  lostReason?: string | null;
}

/**
 * Compute the fields to persist for a transition `from → to`.
 *
 * Throws ConflictError when the transition is not allowed and ValidationError
 * when moving to LOST without a reason. Returns an empty object for a no-op
 * (from === to) so callers can skip the write + audit.
 */
export function applyLeadTransition(
  from: LeadStatus,
  to: LeadStatus,
  options: { lostReason?: string | null; now?: Date } = {},
): LeadTransitionFields {
  if (from === to) return {};
  if (!canTransitionLead(from, to)) {
    throw new ConflictError(
      `Cannot move lead from ${from} to ${to}. Allowed from ${from}: ${LEAD_TRANSITIONS[from].join(", ") || "none (terminal)"}.`,
    );
  }
  if (transitionRequiresLostReason(to) && !options.lostReason?.trim()) {
    throw new ValidationError("Provide a reason for losing this lead.");
  }

  const now = options.now ?? new Date();
  const fields: LeadTransitionFields = {};
  if (to === "CONTACTED") fields.firstContactedAt = now;
  if (to === "QUALIFIED") fields.qualifiedAt = now;
  if (to === "WON") fields.wonAt = now;
  if (to === "LOST") {
    fields.lostAt = now;
    fields.lostReason = options.lostReason?.trim() ?? null;
  }
  return fields;
}

/** Display helper — "NEW" → "New", "ESTIMATE" → "Estimate". */
export function leadStatusLabel(status: LeadStatus): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}
