/** Pure EstimateStatus lifecycle map — mirrors invoice-transitions.test.ts. */
import { describe, expect, it } from "vitest";
import { ConflictError } from "@/lib/errors";
import {
  ESTIMATE_SETTABLE_STATUSES,
  ESTIMATE_STATUSES,
  ESTIMATE_TRANSITIONS,
  allowedNextEstimateStatuses,
  applyEstimateStatusTransition,
  canTransitionEstimateStatus,
  effectiveEstimateStatus,
  estimateStatusLabel,
} from "@/server/domain/estimate-status";

const NOW = new Date("2026-10-01T15:00:00.000Z");

describe("estimate transition map shape", () => {
  it("allows DRAFT → SENT → ACCEPTED | DECLINED", () => {
    expect(ESTIMATE_TRANSITIONS.DRAFT).toEqual(["SENT", "VOID"]);
    expect(ESTIMATE_TRANSITIONS.SENT).toEqual(["ACCEPTED", "DECLINED", "VOID"]);
  });
  it("treats ACCEPTED, DECLINED and VOID as terminal", () => {
    for (const terminal of ["ACCEPTED", "DECLINED", "VOID"] as const) {
      expect(ESTIMATE_TRANSITIONS[terminal]).toEqual([]);
    }
  });
  it("keeps every persisted status mapped and every default settable", () => {
    expect(Object.keys(ESTIMATE_TRANSITIONS).sort()).toEqual([...ESTIMATE_STATUSES].sort());
    expect(ESTIMATE_SETTABLE_STATUSES).toEqual(ESTIMATE_STATUSES);
  });
  it("has no EXPIRED transition target (derived on read only)", () => {
    for (const from of ESTIMATE_STATUSES) {
      expect(ESTIMATE_TRANSITIONS[from]).not.toContain("EXPIRED" as never);
    }
    expect(canTransitionEstimateStatus("DRAFT", "EXPIRED" as never)).toBe(false);
  });
});

describe("applyEstimateStatusTransition", () => {
  it("stamps sentAt when DRAFT reaches SENT (system-set)", () => {
    expect(applyEstimateStatusTransition("DRAFT", "SENT", { now: NOW })).toEqual({ sentAt: NOW });
  });
  it("stamps acceptedAt when SENT reaches ACCEPTED", () => {
    expect(applyEstimateStatusTransition("SENT", "ACCEPTED", { now: NOW })).toEqual({ acceptedAt: NOW });
  });
  it("stamps declinedAt when SENT reaches DECLINED", () => {
    expect(applyEstimateStatusTransition("SENT", "DECLINED", { now: NOW })).toEqual({ declinedAt: NOW });
  });
  it("leaves VOID from DRAFT/SENT unstamped", () => {
    expect(applyEstimateStatusTransition("DRAFT", "VOID", { now: NOW })).toEqual({});
    expect(applyEstimateStatusTransition("SENT", "VOID", { now: NOW })).toEqual({});
  });
  it("rejects out-of-map and terminal-source transitions with ConflictError", () => {
    expect(() => applyEstimateStatusTransition("DRAFT", "ACCEPTED")).toThrow(ConflictError);
    expect(() => applyEstimateStatusTransition("SENT", "SENT")).not.toThrow(); // same-status no-op
    for (const from of ["ACCEPTED", "DECLINED", "VOID"] as const) {
      for (const to of ["SENT", "DECLINED", "ACCEPTED"] as const) {
        if (to === from) continue;
        expect(() => applyEstimateStatusTransition(from, to)).toThrow(ConflictError);
      }
    }
  });
  it("defaults the stamp to the current time when now is omitted", () => {
    const fields = applyEstimateStatusTransition("DRAFT", "SENT");
    expect(fields.sentAt).toBeInstanceOf(Date);
    expect(Math.abs((fields.sentAt!.getTime() - Date.now())) < 5_000).toBe(true);
  });
});

describe("allowedNextEstimateStatuses (UI source of truth)", () => {
  it("offers only server-valid next statuses", () => {
    expect(allowedNextEstimateStatuses("DRAFT")).toEqual(["SENT", "VOID"]);
    expect(allowedNextEstimateStatuses("SENT")).toEqual(["ACCEPTED", "DECLINED", "VOID"]);
    expect(allowedNextEstimateStatuses("ACCEPTED")).toEqual([]);
  });
});

describe("effectiveEstimateStatus — EXPIRED is derived, never persisted", () => {
  const validUntil = new Date("2026-09-01T00:00:00.000Z");
  it("derives EXPIRED from a past validUntil on SENT", () => {
    expect(effectiveEstimateStatus("SENT", validUntil, NOW)).toBe("EXPIRED");
  });
  it("keeps SENT when validUntil is still ahead", () => {
    expect(effectiveEstimateStatus("SENT", new Date("2027-01-01T00:00:00.000Z"), NOW)).toBe("SENT");
  });
  it("never expires without a validUntil", () => {
    expect(effectiveEstimateStatus("SENT", null, NOW)).toBe("SENT");
  });
  it("never expires an outcome state", () => {
    for (const status of ["DRAFT", "ACCEPTED", "DECLINED", "VOID"] as const) {
      expect(effectiveEstimateStatus(status, validUntil, NOW)).toBe(status);
    }
  });
});

describe("estimateStatusLabel", () => {
  it("humanizes statuses", () => {
    expect(estimateStatusLabel("DRAFT")).toBe("Draft");
    expect(estimateStatusLabel("ACCEPTED")).toBe("Accepted");
  });
});
