/**
 * Small domain service at the repository seam. It keeps status writes limited
 * to the pure transition helper and is intentionally dependency-injected for
 * focused unit tests without a live database.
 */
import type { Job, JobStatus } from "@prisma/client";
import { applyJobStatusTransition, type JobTransitionFields } from "@/server/domain/job-transitions";
import type { JobStatusUpdateData } from "@/server/repositories/job.repo";

export interface JobStatusWriter {
  updateStatus(id: string, expectedStatus: JobStatus, data: JobStatusUpdateData): Promise<Job>;
}

export interface PreparedJobStatusUpdate {
  changed: boolean;
  fields: JobTransitionFields;
  data: JobStatusUpdateData;
}

export function prepareJobStatusUpdate(
  from: JobStatus,
  to: JobStatus,
  now?: Date,
): PreparedJobStatusUpdate {
  const fields = applyJobStatusTransition(from, to, { now });
  return { changed: from !== to, fields, data: { status: to, ...fields } };
}

/** Execute a status update only when a real lifecycle transition occurred. */
export async function updateJobStatus(
  repo: JobStatusWriter,
  job: Pick<Job, "id" | "status">,
  to: JobStatus,
  now?: Date,
): Promise<{ changed: boolean; fields: JobTransitionFields; job?: Job }> {
  const prepared = prepareJobStatusUpdate(job.status, to, now);
  if (!prepared.changed) return { changed: false, fields: prepared.fields };
  return {
    changed: true,
    fields: prepared.fields,
    job: await repo.updateStatus(job.id, job.status, prepared.data),
  };
}
