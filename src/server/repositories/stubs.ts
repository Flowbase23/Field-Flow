/**
 * Repository stubs for the remaining tenant models.
 *
 * Each stub factory has the same shape as createCustomerRepo (prisma + orgId →
 * repo object with list/getById/create/update/remove) so callers and
 * tenantDb() already target the final API. They throw NotImplementedError with
 * the slice that will implement them; nothing is silently stubbed.
 */
import type {
  Appointment,
  Invoice,
  Job,
  Technician,
} from "@prisma/client";
import { NotImplementedError } from "@/lib/errors";

export interface StubRepo<T> {
  list(params?: Record<string, unknown>): Promise<T[]>;
  count(params?: Record<string, unknown>): Promise<number>;
  getById(id: string): Promise<T | null>;
  create(data: Record<string, unknown>): Promise<T>;
  update(id: string, data: Record<string, unknown>): Promise<T>;
  remove(id: string): Promise<T>;
}

function makeStubRepo<T>(model: string, slice: string): StubRepo<T> {
  const pending = (method: string): never => {
    throw new NotImplementedError(
      `${model}.${method} is not implemented yet — scheduled for ${slice}.`,
    );
  };
  return {
    list: () => pending("list"),
    count: () => pending("count"),
    getById: () => pending("getById"),
    create: () => pending("create"),
    update: () => pending("update"),
    remove: () => pending("remove"),
  };
}


export const createJobRepo = (_prisma: unknown, _organizationId: string): StubRepo<Job> =>
  makeStubRepo("JobRepo", "Slice 5 (Jobs & dispatch)");

export const createAppointmentRepo = (
  _prisma: unknown,
  _organizationId: string,
): StubRepo<Appointment> => makeStubRepo("AppointmentRepo", "Slice 4 (Scheduling)");

export const createTechnicianRepo = (
  _prisma: unknown,
  _organizationId: string,
): StubRepo<Technician> => makeStubRepo("TechnicianRepo", "Slice 4 (Scheduling)");

export const createInvoiceRepo = (_prisma: unknown, _organizationId: string): StubRepo<Invoice> =>
  makeStubRepo("InvoiceRepo", "Phase 2 (Invoices & payments)");

// Note: createCustomerRepo is intentionally NOT here — it lives in customer.repo.ts
// as the fully implemented worked example.
