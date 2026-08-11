/**
 * Tenant repository composition — the ONLY way feature code reaches tenant models.
 *
 * Never import `db` from "@/server/db/client" in features to query tenant data
 * directly; use `tenantDb(organizationId)` (server/db/tenant-db.ts) or compose
 * repositories here. `organizationId` must originate from requireOrg().
 */
import type { Invoice, Prisma, PrismaClient } from "@prisma/client";
import { createCustomerRepo, type CustomerRepo } from "./customer.repo";
import { createLeadRepo, type LeadRepo } from "./lead.repo";
import { createLocationRepo, type LocationRepo } from "./location.repo";
import { createMembershipRepo, type MembershipRepo } from "./membership.repo";
import { createAppointmentRepo, type AppointmentRepo } from "./appointment.repo";
import { createTechnicianRepo, type TechnicianRepo } from "./technician.repo";
import { createInvoiceRepo, type StubRepo } from "./stubs";
import { createJobRepo, type JobRepo } from "./job.repo";
type Client = Prisma.TransactionClient | PrismaClient;
export interface TenantRepositories {
  memberships: MembershipRepo; // Slice 2 — settings/members mutations
  customers: CustomerRepo; // Slice 3 — CRM
  locations: LocationRepo; // Slice 3 — CRM (nested under customers)
  leads: LeadRepo; // Slice 3 — CRM lead pipeline
  jobs: JobRepo; // Slice 5 — jobs domain foundation
  appointments: AppointmentRepo; // Slice 4 — scheduling & calendar
  technicians: TechnicianRepo; // Slice 4 — technician assignment
  invoices: StubRepo<Invoice>; // Phase 2
}
export function tenantRepositories(
  prisma: Client,
  organizationId: string,
): TenantRepositories {
  return {
    memberships: createMembershipRepo(prisma, organizationId),
    customers: createCustomerRepo(prisma, organizationId),
    locations: createLocationRepo(prisma, organizationId),
    leads: createLeadRepo(prisma, organizationId),
    jobs: createJobRepo(prisma, organizationId),
    appointments: createAppointmentRepo(prisma, organizationId),
    technicians: createTechnicianRepo(prisma, organizationId),
    invoices: createInvoiceRepo(prisma, organizationId),
  };
}
