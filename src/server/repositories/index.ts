/**
 * Tenant repository composition — the ONLY way feature code reaches tenant models.
 *
 * Never import `db` from "@/server/db/client" in features to query tenant data
 * directly; use `tenantDb(organizationId)` (server/db/tenant-db.ts) or compose
 * repositories here. `organizationId` must originate from requireOrg().
 */
import type { Appointment, Invoice, Job, Prisma, PrismaClient, Technician } from "@prisma/client";
import { createCustomerRepo, type CustomerRepo } from "./customer.repo";
import { createLeadRepo, type LeadRepo } from "./lead.repo";
import { createLocationRepo, type LocationRepo } from "./location.repo";
import { createMembershipRepo, type MembershipRepo } from "./membership.repo";
import {
  createAppointmentRepo,
  createInvoiceRepo,
  createJobRepo,
  createTechnicianRepo,
  type StubRepo,
} from "./stubs";
type Client = Prisma.TransactionClient | PrismaClient;
export interface TenantRepositories {
  memberships: MembershipRepo; // Slice 2 — settings/members mutations
  customers: CustomerRepo; // Slice 3 — CRM
  locations: LocationRepo; // Slice 3 — CRM (nested under customers)
  leads: LeadRepo; // Slice 3 — CRM lead pipeline
  jobs: StubRepo<Job>; // Slice 5
  appointments: StubRepo<Appointment>; // Slice 4
  technicians: StubRepo<Technician>; // Slice 4
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
