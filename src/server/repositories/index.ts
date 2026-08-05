/**
 * Tenant repository composition — the ONLY way feature code reaches tenant models.
 *
 * Never import `db` from "@/server/db/client" in features to query tenant data
 * directly; use `tenantDb(organizationId)` (server/db/tenant-db.ts) or compose
 * repositories here. `organizationId` must originate from requireOrg().
 */
import type { Appointment, Invoice, Job, Lead, Prisma, PrismaClient, Technician } from "@prisma/client";
import { createCustomerRepo, type CustomerRepo } from "./customer.repo";
import {
  createAppointmentRepo,
  createInvoiceRepo,
  createJobRepo,
  createLeadRepo,
  createTechnicianRepo,
  type StubRepo,
} from "./stubs";

type Client = Prisma.TransactionClient | PrismaClient;

export interface TenantRepositories {
  customers: CustomerRepo;
  leads: StubRepo<Lead>; // Slice 3
  jobs: StubRepo<Job>; // Slice 5
  appointments: StubRepo<Appointment>; // Slice 4
  technicians: StubRepo<Technician>; // Slice 4
  invoices: StubRepo<Invoice>; // Phase 2
}

export function tenantRepositories(
  prisma: PrismaClient,
  organizationId: string,
): TenantRepositories {
  return {
    customers: createCustomerRepo(prisma, organizationId),
    leads: createLeadRepo(prisma, organizationId),
    jobs: createJobRepo(prisma, organizationId),
    appointments: createAppointmentRepo(prisma, organizationId),
    technicians: createTechnicianRepo(prisma, organizationId),
    invoices: createInvoiceRepo(prisma, organizationId),
  };
}
