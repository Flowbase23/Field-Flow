/**
 * Clerk webhook receiver — syncs Clerk identity/organization events into the
 * local Organization/User/Membership tables (design §1 tenant identity mapping,
 * §8.5 sync drift risks).
 *
 * - Signature verification via svix (the `svix-*` headers) using
 *   CLERK_WEBHOOK_SECRET.
 * - Handlers are IDEMPOTENT (upserts by Clerk external ids) and follow
 *   "mark-inactive-not-delete" for external deletions (design §8.5).
 * - Missing local org on membership events is treated as "not provisioned yet":
 *   we log and return 200 rather than guessing (design §8.5: "treat missing org
 *   as unavailable (no guessing)"). A reconciliation job is planned for Slice 2.
 *
 * PENDING LIVE VERIFICATION: signature verification and the exact payload
 * shapes must be exercised against a real Clerk instance once
 * CLERK_WEBHOOK_SECRET is provisioned. Types come from @clerk/backend
 * (re-exported by @clerk/nextjs/server) and match Clerk's documented webhook
 * payloads as of this writing.
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { Webhook, WebhookVerificationError } from "svix";
import type {
  OrganizationMembershipWebhookEvent,
  OrganizationWebhookEvent,
  UserWebhookEvent,
  WebhookEvent,
} from "@clerk/nextjs/server";
import { db } from "@/server/db/client";
import { Role } from "@prisma/client";

export const dynamic = "force-dynamic";

function log(level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
  // TODO(Slice 2): route through a proper logger (pino) — console is fine until then.
  const line = `[webhook:clerk] ${msg}`;
  if (level === "error") console.error(line, extra ?? "");
  else if (level === "warn") console.warn(line, extra ?? "");
  else console.log(line, extra ?? "");
}

/** "org:admin" → ADMIN; anything else gets the OFFICE_STAFF default. */
function mapClerkRoleToLocal(clerkRole: string | undefined): Role {
  return clerkRole === "org:admin" ? Role.ADMIN : Role.OFFICE_STAFF;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "org";
}

async function handleOrganizationCreated(evt: OrganizationWebhookEvent): Promise<void> {
  const d = evt.data;
  await db.organization.upsert({
    where: { clerkOrganizationId: d.id },
    create: {
      clerkOrganizationId: d.id,
      slug: d.slug ?? slugify(d.name ?? d.id),
      name: d.name ?? "Unnamed organization",
    },
    update: {
      slug: d.slug ?? undefined,
      name: d.name ?? undefined,
      isActive: true,
    },
  });
  log("info", `organization.created upserted ${d.id}`);
}

async function handleOrganizationDeleted(evt: OrganizationWebhookEvent): Promise<void> {
  const d = evt.data;
  // Mark-inactive-not-delete (design §8.5): tombstone the slug so a future org
  // reusing the same slug can't collide on the unique constraint, and deactivate
  // all memberships so requireOrg() fails closed for everyone.
  const result = await db.organization.updateMany({
    where: { clerkOrganizationId: d.id },
    data: {
      isActive: false,
      slug: `__deleted__${d.id}`,
    },
  });
  if (result.count > 0) {
    const org = await db.organization.findUnique({ where: { clerkOrganizationId: d.id } });
    if (org) {
      await db.membership.updateMany({
        where: { organizationId: org.id },
        data: { isActive: false },
      });
    }
  }
  log("info", `organization.deleted handled for ${d.id} (inactive:${result.count > 0})`);
}

async function handleUserCreated(evt: UserWebhookEvent): Promise<void> {
  const d = evt.data;
  const primaryEmail =
    d.email_addresses?.find((e) => e.id === d.primary_email_address_id)?.email_address ??
    d.email_addresses?.[0]?.email_address ??
    "";
  await db.user.upsert({
    where: { clerkUserId: d.id },
    create: {
      clerkUserId: d.id,
      email: primaryEmail,
      firstName: d.first_name ?? null,
      lastName: d.last_name ?? null,
    },
    update: {
      email: primaryEmail,
      firstName: d.first_name ?? null,
      lastName: d.last_name ?? null,
    },
  });
  log("info", `user.created upserted ${d.id}`);
}

async function handleMembershipCreated(evt: OrganizationMembershipWebhookEvent): Promise<void> {
  const d = evt.data;
  const clerkOrgId = d.organization?.id;
  const clerkUserId = d.public_user_data?.user_id;
  if (!clerkOrgId || !clerkUserId) {
    log("warn", "organizationMembership.created missing org/user ids", d);
    return;
  }

  // Fail closed on missing org — do NOT create an org from a membership event.
  const org = await db.organization.findUnique({ where: { clerkOrganizationId: clerkOrgId } });
  if (!org) {
    log(
      "warn",
      `organizationMembership.created for unknown org ${clerkOrgId} — expected if the ` +
        "organization.created webhook hasn't arrived yet; reconciliation job (Slice 2) will fix drift",
    );
    return;
  }

  // Ensure the user row exists (it may arrive as a separate event).
  const user = await db.user.upsert({
    where: { clerkUserId },
    create: {
      clerkUserId,
      email: d.public_user_data?.identifier ?? "",
      firstName: d.public_user_data?.first_name ?? null,
      lastName: d.public_user_data?.last_name ?? null,
    },
    update: {},
  });

  const role = mapClerkRoleToLocal(d.role);
  await db.membership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    create: { organizationId: org.id, userId: user.id, role, isActive: true },
    update: { role, isActive: true },
  });
  log("info", `organizationMembership.created/updated upserted ${clerkUserId} → ${clerkOrgId} (${role})`);
}

async function handleMembershipDeleted(evt: OrganizationMembershipWebhookEvent): Promise<void> {
  const d = evt.data;
  const clerkOrgId = d.organization?.id;
  const clerkUserId = d.public_user_data?.user_id;
  if (!clerkOrgId || !clerkUserId) {
    log("warn", "organizationMembership.deleted missing org/user ids", d);
    return;
  }
  // Mark-inactive-not-delete.
  await db.membership.updateMany({
    where: {
      organization: { clerkOrganizationId: clerkOrgId },
      user: { clerkUserId },
      isActive: true,
    },
    data: { isActive: false },
  });
  log("info", `organizationMembership.deleted deactivated ${clerkUserId} in ${clerkOrgId}`);
}

export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    log("error", "CLERK_WEBHOOK_SECRET is not configured — rejecting webhook");
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
  }

  const headerPayload = await headers();
  const svixId = headerPayload.get("svix-id");
  const svixTimestamp = headerPayload.get("svix-timestamp");
  const svixSignature = headerPayload.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing svix headers" }, { status: 400 });
  }

  const payload = await req.text();

  let evt: WebhookEvent;
  try {
    evt = new Webhook(secret).verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as WebhookEvent;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      log("warn", "webhook signature verification failed");
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
    throw err;
  }

  try {
    switch (evt.type) {
      case "organization.created":
        await handleOrganizationCreated(evt);
        break;
      case "organization.deleted":
        await handleOrganizationDeleted(evt);
        break;
      case "organization.updated":
        await handleOrganizationCreated(evt); // same upsert semantics
        break;
      case "user.created":
      case "user.updated":
        await handleUserCreated(evt);
        break;
      case "organizationMembership.created":
      case "organizationMembership.updated":
        await handleMembershipCreated(evt);
        break;
      case "organizationMembership.deleted":
        await handleMembershipDeleted(evt);
        break;
      default:
        // session.*, invitation.*, email.*, sms.*, waitlist.*, ... — nothing to
        // sync locally. Acknowledge so Clerk stops retrying.
        log("info", `ignored event type: ${evt.type}`);
    }
  } catch (err) {
    log("error", `handler failed for ${evt.type}`, err);
    // Return 500 so Clerk retries with backoff.
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
