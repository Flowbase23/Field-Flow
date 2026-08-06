/**
 * Location repository — tenant-scoped access to the Location model (Phase 1,
 * Slice 3). Follows the createCustomerRepo pattern (design §2, mechanism B).
 *
 * Locations are always nested under a customer: every query injects BOTH the
 * organizationId and customerId predicates, and create takes the customerId
 * from the caller (the action verifies the customer belongs to the org first —
 * the schema's compound FK `Location.customer → (Customer.id, Customer.organizationId)`
 * is the database backstop).
 *
 * Location HAS `@@unique([id, organizationId])`, so updates/deletes use the
 * compound `id_organizationId` selector — a cross-tenant write is impossible at
 * the DB level (mechanism D).
 *
 * The repository is DB-only: input is expected to be already validated (Zod)
 * and authorized (requirePermission) by the caller.
 */
import { Prisma, type Location, type PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "@/lib/errors";

export interface LocationCreateData {
  customerId: string;
  label?: string;
  address1: string;
  address2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  timezone?: string | null;
  accessNotes?: string | null;
}

export type LocationUpdateData = Partial<Omit<LocationCreateData, "customerId">>;

export interface LocationRepo {
  /** All locations for a customer within the org (label asc, then createdAt). */
  listByCustomer(customerId: string): Promise<Location[]>;
  /** Tenant-scoped lookup; cross-tenant ids return null (→ NotFoundError upstream). */
  getById(id: string): Promise<Location | null>;
  create(data: LocationCreateData): Promise<Location>;
  update(id: string, data: LocationUpdateData): Promise<Location>;
  /** Hard delete via the compound selector. FK-linked rows (jobs/appointments) → ConflictError. */
  remove(id: string): Promise<Location>;
}

type Client = Prisma.TransactionClient | PrismaClient;

export function createLocationRepo(prisma: Client, organizationId: string): LocationRepo {
  const tenant = { organizationId } as const;

  return {
    async listByCustomer(customerId) {
      return prisma.location.findMany({
        where: { ...tenant, customerId },
        orderBy: [{ label: "asc" }, { createdAt: "asc" }],
      });
    },

    async getById(id) {
      return prisma.location.findFirst({ where: { id, ...tenant } });
    },

    async create(data) {
      const { customerId, ...fields } = data;
      return prisma.location.create({ data: { ...tenant, customerId, ...fields } });
    },

    async update(id, data) {
      // Compound unique selector — cross-tenant updates are rejected by the DB.
      return prisma.location.update({
        where: { id_organizationId: { id, organizationId } },
        data,
      });
    },

    async remove(id) {
      const existing = await prisma.location.findFirst({ where: { id, ...tenant } });
      if (!existing) {
        throw new NotFoundError("Location not found in this organization.");
      }
      try {
        await prisma.location.delete({ where: { id_organizationId: { id, organizationId } } });
      } catch (err) {
        // P2003 = foreign key constraint failed (jobs/appointments reference the location).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
          throw new ConflictError(
            "This location is linked to jobs or appointments and cannot be deleted. Move those records first.",
          );
        }
        throw err;
      }
      return existing;
    },
  };
}
