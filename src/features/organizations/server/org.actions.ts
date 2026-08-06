/**
 * Organization settings server action (Slice 2 follow-up).
 *
 * updateOrg: requires ORGANIZATION_UPDATE, Zod-validates name/timezone/
 * currency (slug is intentionally not editable), writes through the org-scoped
 * path (the organization id comes from requireOrg()'s session context — never
 * the browser) and audits the change (UPDATE, before/after snapshots).
 *
 * Timezone flows: requireOrg() reads Organization.timezone fresh on every
 * request, and dashboard/date helpers (orgDayRange in src/lib/dates.ts) take it
 * as a parameter — so a saved timezone is picked up by subsequent requests with
 * no extra invalidation beyond revalidatePath.
 */
"use server";

import { AuditAction, Permission } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/require-org";
import { withAudit } from "@/server/audit";
import { actionError, type ActionResult } from "@/lib/errors";
import { organizationUpdateSchema, type OrganizationUpdateInput } from "../schemas";

export interface OrgSettingsResult {
  id: string;
  name: string;
  timezone: string;
  currency: string;
}

export async function updateOrg(
  input: unknown,
): Promise<ActionResult<OrgSettingsResult>> {
  try {
    const ctx = await requirePermission(Permission.ORGANIZATION_UPDATE);
    const data: OrganizationUpdateInput = organizationUpdateSchema.parse(input);

    const before = {
      name: ctx.organization.name,
      timezone: ctx.organization.timezone,
      currency: ctx.organization.currency,
    };
    if (before.name === data.name && before.timezone === data.timezone && before.currency === data.currency) {
      return { ok: true, data: { id: ctx.organizationId, ...data } }; // no-op, nothing to audit
    }

    const updated = await withAudit(
      {
        organizationId: ctx.organizationId,
        action: AuditAction.UPDATE,
        entityType: "Organization",
        entityId: ctx.organizationId,
        before,
        after: data,
        actorUserId: ctx.userId,
        actorClerkUserId: ctx.clerkUserId,
      },
      (tx) => tx.organization.update({ where: { id: ctx.organizationId }, data }),
    );

    // Refresh the settings page and the org shell (org name shows in the nav).
    revalidatePath(`/${ctx.organization.slug}/settings`);
    revalidatePath(`/${ctx.organization.slug}`);

    return {
      ok: true,
      data: { id: updated.id, name: updated.name, timezone: updated.timezone, currency: updated.currency },
    };
  } catch (err) {
    return actionError(err);
  }
}
