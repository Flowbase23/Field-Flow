/**
 * Location server actions (Phase 1, Slice 3) — locations are managed nested
 * inside the customer detail page.
 *
 * Conventions (as customer.actions.ts): requirePermission → Zod → tenant-scoped
 * repo → withAudit in the same transaction → ActionResult.
 *
 * Tenant safety is enforced twice: the action verifies the PARENT customer
 * belongs to the org before create (cross-tenant customerId → NotFoundError),
 * and every repo call injects the organizationId predicate (the schema's
 * compound FK `Location.customer → (Customer.id, Customer.organizationId)` is
 * the database backstop).
 *
 * PENDING LIVE VERIFICATION: requirePermission() needs a real Clerk session;
 * DB writes are untested until the verification pass.
 */
"use server";

import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/require-org";
import { createCustomerRepo } from "@/server/repositories/customer.repo";
import { createLocationRepo } from "@/server/repositories/location.repo";
import { db } from "@/server/db/client";
import { withAudit } from "@/server/audit";
import { NotFoundError, actionError, type ActionResult } from "@/lib/errors";
import {
  locationCreateActionSchema,
  locationDeleteSchema,
  locationUpdateActionSchema,
  type LocationCreateActionInput,
  type LocationUpdateActionInput,
} from "../schemas";

function locationSnapshot(loc: {
  label: string;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude: unknown;
  longitude: unknown;
  timezone: string | null;
  accessNotes: string | null;
}): Record<string, unknown> {
  return {
    label: loc.label,
    address1: loc.address1,
    address2: loc.address2,
    city: loc.city,
    state: loc.state,
    postalCode: loc.postalCode,
    country: loc.country,
    latitude: loc.latitude,
    longitude: loc.longitude,
    timezone: loc.timezone,
    accessNotes: loc.accessNotes,
  };
}

export interface LocationActionResult {
  id: string;
  customerId: string;
  label: string;
  address1: string;
  city: string;
  state: string;
}

/**
 * Add a location to a customer.
 * Guards: CUSTOMER_UPDATE, Zod schema, parent customer must exist in the org
 * (cross-tenant customerId → NotFoundError). Audited (CREATE).
 */
export async function createLocation(input: unknown): Promise<ActionResult<LocationActionResult>> {
  try {
    const ctx = await requirePermission(Permission.CUSTOMER_UPDATE);
    const { customerId, ...data }: LocationCreateActionInput = locationCreateActionSchema.parse(input);

    const customer = await createCustomerRepo(db, ctx.organizationId).getById(customerId);
    if (!customer) {
      throw new NotFoundError("Customer not found in this organization.");
    }

    const created = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.CREATE,
        entityType: "Location",
        entityId: undefined,
        before: null,
        after: { customerId, ...data },
        metadata: { customerId },
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createLocationRepo(tx, ctx.organizationId).create({ customerId, ...data }),
    );

    revalidatePath(`/${ctx.organization.slug}/customers/${customerId}`);
    return {
      ok: true,
      data: {
        id: created.id,
        customerId,
        label: created.label,
        address1: created.address1,
        city: created.city,
        state: created.state,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Update a location (label/address/coords/timezone/access notes).
 * Guards: CUSTOMER_UPDATE, Zod schema, tenant-scoped target (NotFoundError
 * off-tenant). Audited (UPDATE, before/after).
 */
export async function updateLocation(input: unknown): Promise<ActionResult<LocationActionResult>> {
  try {
    const ctx = await requirePermission(Permission.CUSTOMER_UPDATE);
    const { id, ...data }: LocationUpdateActionInput = locationUpdateActionSchema.parse(input);

    const repo = createLocationRepo(db, ctx.organizationId);
    const existing = await repo.getById(id);
    if (!existing) {
      throw new NotFoundError("Location not found in this organization.");
    }

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.UPDATE,
        entityType: "Location",
        entityId: id,
        before: locationSnapshot(existing),
        after: locationSnapshot({ ...existing, ...data }),
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createLocationRepo(tx, ctx.organizationId).update(id, data),
    );

    revalidatePath(`/${ctx.organization.slug}/customers/${existing.customerId}`);
    return {
      ok: true,
      data: {
        id: updated.id,
        customerId: updated.customerId,
        label: updated.label,
        address1: updated.address1,
        city: updated.city,
        state: updated.state,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Delete a location (hard delete — Location has no soft-delete flag).
 * Guards: CUSTOMER_DELETE, Zod schema, tenant-scoped target (NotFoundError
 * off-tenant); FK-linked locations (jobs/appointments — future slices) are
 * rejected with a ConflictError by the repo. Audited (DELETE, before).
 */
export async function deleteLocation(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const ctx = await requirePermission(Permission.CUSTOMER_DELETE);
    const { id } = locationDeleteSchema.parse(input);

    const repo = createLocationRepo(db, ctx.organizationId);
    const existing = await repo.getById(id);
    if (!existing) {
      throw new NotFoundError("Location not found in this organization.");
    }

    await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.DELETE,
        entityType: "Location",
        entityId: id,
        before: locationSnapshot(existing),
        after: null,
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => createLocationRepo(tx, ctx.organizationId).remove(id),
    );

    revalidatePath(`/${ctx.organization.slug}/customers/${existing.customerId}`);
    return { ok: true, data: { id } };
  } catch (err) {
    return actionError(err);
  }
}
