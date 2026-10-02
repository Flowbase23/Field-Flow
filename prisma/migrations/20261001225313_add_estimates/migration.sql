-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'VOID');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Permission" ADD VALUE 'ESTIMATE_READ';
ALTER TYPE "Permission" ADD VALUE 'ESTIMATE_CREATE';
ALTER TYPE "Permission" ADD VALUE 'ESTIMATE_UPDATE';
ALTER TYPE "Permission" ADD VALUE 'ESTIMATE_DELETE';
ALTER TYPE "Permission" ADD VALUE 'ESTIMATE_STATUS_UPDATE';

-- CreateTable
CREATE TABLE "Estimate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobId" TEXT,
    "estimateNumber" INTEGER NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "validUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Estimate_organizationId_status_validUntil_idx" ON "Estimate"("organizationId", "status", "validUntil");

-- CreateIndex
CREATE INDEX "Estimate_organizationId_customerId_idx" ON "Estimate"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "Estimate_organizationId_jobId_idx" ON "Estimate"("organizationId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_organizationId_estimateNumber_key" ON "Estimate"("organizationId", "estimateNumber");

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_customerId_organizationId_fkey" FOREIGN KEY ("customerId", "organizationId") REFERENCES "Customer"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
