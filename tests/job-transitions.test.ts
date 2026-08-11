import { describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import {
  JOB_STATUSES,
  JOB_TRANSITIONS,
  allowedNextJobStatuses,
  applyJobStatusTransition,
  canTransitionJobStatus,
} from "@/server/domain/job-transitions";
import { prepareJobStatusUpdate, updateJobStatus } from "@/server/services/job.service";

const NOW = new Date("2026-08-07T12:00:00.000Z");

describe("job status transition map", () => {
  it("implements the exact designed lifecycle and covers every status", () => {
    expect(Object.keys(JOB_TRANSITIONS).sort()).toEqual([...JOB_STATUSES].sort());
    expect(JOB_TRANSITIONS.DRAFT).toEqual(["UNSCHEDULED", "CANCELLED"]);
    expect(JOB_TRANSITIONS.UNSCHEDULED).toEqual(["SCHEDULED", "CANCELLED"]);
    expect(JOB_TRANSITIONS.SCHEDULED).toEqual(["EN_ROUTE", "IN_PROGRESS", "CANCELLED"]);
    expect(JOB_TRANSITIONS.EN_ROUTE).toEqual(["IN_PROGRESS", "CANCELLED"]);
    expect(JOB_TRANSITIONS.IN_PROGRESS).toEqual(["ON_HOLD", "COMPLETED", "CANCELLED"]);
    expect(JOB_TRANSITIONS.ON_HOLD).toEqual(["IN_PROGRESS", "CANCELLED"]);
    expect(allowedNextJobStatuses("COMPLETED")).toEqual([]);
    expect(allowedNextJobStatuses("CANCELLED")).toEqual([]);
  });

  it("rejects skips, backwards moves, and all transitions from terminal statuses", () => {
    expect(canTransitionJobStatus("DRAFT", "SCHEDULED")).toBe(false);
    expect(() => applyJobStatusTransition("DRAFT", "SCHEDULED", { now: NOW })).toThrow(ConflictError);
    expect(() => applyJobStatusTransition("ON_HOLD", "SCHEDULED", { now: NOW })).toThrow(ConflictError);
    for (const terminal of ["COMPLETED", "CANCELLED"] as const) {
      for (const target of JOB_STATUSES) expect(canTransitionJobStatus(terminal, target)).toBe(false);
    }
  });

  it("makes same status a no-op and writes lifecycle timestamps only on their destinations", () => {
    expect(applyJobStatusTransition("SCHEDULED", "SCHEDULED", { now: NOW })).toEqual({});
    expect(applyJobStatusTransition("IN_PROGRESS", "COMPLETED", { now: NOW })).toEqual({ completedAt: NOW });
    expect(applyJobStatusTransition("DRAFT", "CANCELLED", { now: NOW })).toEqual({ cancelledAt: NOW });
    expect(applyJobStatusTransition("SCHEDULED", "EN_ROUTE", { now: NOW })).toEqual({});
  });

  it("keeps timestamp persistence at the repository/service seam", async () => {
    const writes: unknown[] = [];
    const writer = {
      updateStatus: async (id: string, expectedStatus: string, data: unknown) => {
        writes.push({ id, expectedStatus, data });
        return { id, status: "COMPLETED" } as never;
      },
    };
    const prepared = prepareJobStatusUpdate("IN_PROGRESS", "COMPLETED", NOW);
    expect(prepared.data).toEqual({ status: "COMPLETED", completedAt: NOW });
    const completed = await updateJobStatus(writer, { id: "job-1", status: "IN_PROGRESS" } as never, "COMPLETED", NOW);
    expect(completed.changed).toBe(true);
    expect(writes).toEqual([{ id: "job-1", expectedStatus: "IN_PROGRESS", data: { status: "COMPLETED", completedAt: NOW } }]);

    await updateJobStatus(writer, { id: "job-1", status: "COMPLETED" } as never, "COMPLETED", NOW);
    expect(writes).toHaveLength(1);
  });
});
