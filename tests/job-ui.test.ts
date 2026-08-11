import { describe, expect, it } from "vitest";
import { jobStatusActions, parseJobListFilters } from "@/features/jobs/job-ui";

describe("Jobs UI route and lifecycle helpers", () => {
  it("accepts only known status and priority URL filters", () => {
    expect(parseJobListFilters({ status: "IN_PROGRESS", priority: "URGENT" })).toEqual({ status: "IN_PROGRESS", priority: "URGENT" });
    expect(parseJobListFilters({ status: "NOT_A_STATUS", priority: "rush" })).toEqual({ status: undefined, priority: undefined });
    expect(parseJobListFilters({})).toEqual({ status: undefined, priority: undefined });
  });

  it("maps only allowed next statuses to clear lifecycle actions", () => {
    expect(jobStatusActions("SCHEDULED")).toEqual([
      { status: "EN_ROUTE", label: "Mark en route" },
      { status: "IN_PROGRESS", label: "Start job" },
      { status: "CANCELLED", label: "Cancel job", destructive: true },
    ]);
    expect(jobStatusActions("IN_PROGRESS")).toEqual([
      { status: "ON_HOLD", label: "Place on hold" },
      { status: "COMPLETED", label: "Complete job" },
      { status: "CANCELLED", label: "Cancel job", destructive: true },
    ]);
    expect(jobStatusActions("COMPLETED")).toEqual([]);
  });
});
