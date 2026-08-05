/**
 * Tenant-scoped database access (design §1 mechanism B + §2 repository structure).
 *
 * Rule: tenant models (Customer, Location, Lead, Technician, Job, Appointment,
 * TimeEntry, Invoice, Membership, RolePermission, AuditLog) are NEVER queried
 * directly with the global `db` client from feature code. They are only reached
 * through `tenantDb(organizationId)` / the repositories, which inject the
 * `organizationId` predicate on every query. Raw SQL (`$queryRaw`) is banned for
 * tenant models entirely.
 *
 * `organizationId` here must come from requireOrg()'s OrgContext — never from
 * the browser.
 */
import { db } from "@/server/db/client";
import { tenantRepositories } from "@/server/repositories";

export type TenantDb = ReturnType<typeof tenantRepositories>;

export function tenantDb(organizationId: string): TenantDb {
  return tenantRepositories(db, organizationId);
}
