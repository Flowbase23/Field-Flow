-- Estimate → Job conversion (Phase 2 Slice P2-2 follow-up).
--
-- Job.estimateId records the provenance of a job created by converting an
-- ACCEPTED estimate. The compound unique index makes the conversion once-only
-- AT THE DATABASE LEVEL: a second convert of the same estimate violates it
-- (the Job repository maps that violation to a ConflictError). The FK is an
-- id-only optional link with SET NULL, matching the schema header note 1
-- convention for optional links (the tenant predicate stays in the repository).
ALTER TABLE "Job" ADD COLUMN "estimateId" TEXT;
-- CreateIndex
CREATE UNIQUE INDEX "Job_organizationId_estimateId_key" ON "Job"("organizationId", "estimateId");
-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "Estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Job.locationId becomes optional: a converted job can start WITHOUT a service
-- location when none can be derived, and the user fills it in later from the
-- job edit form. Manual job creation still always carries one (the create
-- schema and the job form keep requiring it) — only the column relaxes.
ALTER TABLE "Job" ALTER COLUMN "locationId" DROP NOT NULL;
