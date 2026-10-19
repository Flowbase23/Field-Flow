-- AlterEnum
-- Phase 2 Slice P2-S5 (technician portal): time-entry permissions. The
-- TimeEntry MODEL already exists (created in the init migration); this
-- migration only adds the two permissions that gate its UI/actions.
ALTER TYPE "Permission" ADD VALUE 'TIME_READ';
ALTER TYPE "Permission" ADD VALUE 'TIME_CREATE';
