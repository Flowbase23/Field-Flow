-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Permission" ADD VALUE 'INVOICE_READ';
ALTER TYPE "Permission" ADD VALUE 'INVOICE_CREATE';
ALTER TYPE "Permission" ADD VALUE 'INVOICE_UPDATE';
ALTER TYPE "Permission" ADD VALUE 'INVOICE_DELETE';
ALTER TYPE "Permission" ADD VALUE 'INVOICE_STATUS_UPDATE';
