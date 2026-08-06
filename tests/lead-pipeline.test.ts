/**
 * Pure-logic tests for the lead pipeline transition map
 * (src/server/domain/lead-pipeline.ts) — the server-enforced status rules:
 * forward-only pipeline, WON/LOST terminal, LOST requires a reason, and the
 * timestamp bookkeeping that feeds the dashboard's conversion cohort.
 */
import { describe, expect, it } from "vitest";
import {
  applyLeadTransition,
  canTransitionLead,
  LEAD_TRANSITIONS,
  transitionRequiresLostReason,
} from "@/server/domain/lead-pipeline";
import { ConflictError, ValidationError } from "@/lib/errors";

const NOW = new Date("2026-08-06T12:00:00.000Z");

describe("lead transition map", () => {
  it("allows every documented forward transition", () => {
    expect(canTransitionLead("NEW", "CONTACTED")).toBe(true);
    expect(canTransitionLead("CONTACTED", "QUALIFIED")).toBe(true);
    expect(canTransitionLead("QUALIFIED", "ESTIMATE")).toBe(true);
    expect(canTransitionLead("ESTIMATE", "WON")).toBe(true);
    // Any non-terminal status can be lost (with a reason).
    for (const from of ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATE"] as const) {
      expect(canTransitionLead(from, "LOST")).toBe(true);
    }
  });

  it("rejects skipped stages (no fast-forwarding)", () => {
    expect(canTransitionLead("NEW", "QUALIFIED")).toBe(false);
    expect(canTransitionLead("NEW", "ESTIMATE")).toBe(false);
    expect(canTransitionLead("NEW", "WON")).toBe(false);
    expect(canTransitionLead("CONTACTED", "ESTIMATE")).toBe(false);
    expect(canTransitionLead("CONTACTED", "WON")).toBe(false);
    expect(canTransitionLead("QUALIFIED", "WON")).toBe(false);
  });

  it("treats WON and LOST as terminal", () => {
    for (const to of ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATE", "WON", "LOST"] as const) {
      expect(canTransitionLead("WON", to)).toBe(false);
      expect(canTransitionLead("LOST", to)).toBe(false);
    }
    expect(LEAD_TRANSITIONS.WON).toEqual([]);
    expect(LEAD_TRANSITIONS.LOST).toEqual([]);
  });

  it("does not allow backwards movement", () => {
    expect(canTransitionLead("CONTACTED", "NEW")).toBe(false);
    expect(canTransitionLead("QUALIFIED", "CONTACTED")).toBe(false);
    expect(canTransitionLead("ESTIMATE", "QUALIFIED")).toBe(false);
  });

  it("only LOST requires a lost reason", () => {
    expect(transitionRequiresLostReason("LOST")).toBe(true);
    for (const to of ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATE", "WON"] as const) {
      expect(transitionRequiresLostReason(to)).toBe(false);
    }
  });
});

describe("applyLeadTransition", () => {
  it("sets firstContactedAt when a lead is first contacted", () => {
    const fields = applyLeadTransition("NEW", "CONTACTED", { now: NOW });
    expect(fields.firstContactedAt).toEqual(NOW);
    expect(fields.qualifiedAt).toBeUndefined();
  });

  it("sets qualifiedAt when qualified and wonAt when won", () => {
    expect(applyLeadTransition("CONTACTED", "QUALIFIED", { now: NOW }).qualifiedAt).toEqual(NOW);
    expect(applyLeadTransition("ESTIMATE", "WON", { now: NOW }).wonAt).toEqual(NOW);
  });

  it("sets lostAt and stores the lostReason when losing", () => {
    const fields = applyLeadTransition("ESTIMATE", "LOST", { lostReason: "  chose competitor  ", now: NOW });
    expect(fields.lostAt).toEqual(NOW);
    expect(fields.lostReason).toBe("chose competitor");
  });

  it("throws ValidationError when losing without a reason", () => {
    expect(() => applyLeadTransition("NEW", "LOST", { now: NOW })).toThrow(ValidationError);
    expect(() => applyLeadTransition("NEW", "LOST", { lostReason: "", now: NOW })).toThrow(ValidationError);
    expect(() => applyLeadTransition("NEW", "LOST", { lostReason: "   ", now: NOW })).toThrow(ValidationError);
  });

  it("throws ConflictError for illegal transitions", () => {
    expect(() => applyLeadTransition("NEW", "WON", { now: NOW })).toThrow(ConflictError);
    expect(() => applyLeadTransition("QUALIFIED", "WON", { now: NOW })).toThrow(ConflictError);
    expect(() => applyLeadTransition("WON", "LOST", { lostReason: "x", now: NOW })).toThrow(ConflictError);
    expect(() => applyLeadTransition("LOST", "NEW", { now: NOW })).toThrow(ConflictError);
  });

  it("returns an empty object for a same-status no-op", () => {
    expect(applyLeadTransition("NEW", "NEW", { now: NOW })).toEqual({});
    expect(applyLeadTransition("WON", "WON", { now: NOW })).toEqual({});
  });

  it("uses the real clock when no now is supplied", () => {
    const before = new Date();
    const fields = applyLeadTransition("NEW", "CONTACTED");
    const after = new Date();
    expect(fields.firstContactedAt).toBeInstanceOf(Date);
    expect(fields.firstContactedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(fields.firstContactedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
