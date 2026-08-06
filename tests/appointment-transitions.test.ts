/**
 * Appointment status transition map tests (Phase 1, Slice 4).
 *
 * The map is server-enforced: applyAppointmentTransition is the ONLY way a
 * status change is persisted (create/update go through setAppointmentStatus /
 * cancelAppointment / markMissed), so invalid transitions must throw even
 * though the UI only offers valid ones.
 */
import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_TRANSITIONS,
  allowedNextAppointmentStatuses,
  appointmentStatusLabel,
  applyAppointmentTransition,
  canTransitionAppointmentStatus,
} from "@/server/domain/appointment-transitions";
import { ConflictError } from "@/lib/errors";

const NOW = new Date("2026-06-15T12:00:00Z");

describe("appointment status transition map", () => {
  it("covers every enum value exactly once as a key", () => {
    expect(Object.keys(APPOINTMENT_TRANSITIONS).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
    for (const status of APPOINTMENT_STATUSES) {
      for (const target of APPOINTMENT_TRANSITIONS[status]) {
        expect(APPOINTMENT_STATUSES).toContain(target);
      }
    }
  });

  it("allows the forward path TENTATIVE → CONFIRMED → EN_ROUTE → IN_PROGRESS → COMPLETED", () => {
    expect(canTransitionAppointmentStatus("TENTATIVE", "CONFIRMED")).toBe(true);
    expect(canTransitionAppointmentStatus("CONFIRMED", "EN_ROUTE")).toBe(true);
    expect(canTransitionAppointmentStatus("EN_ROUTE", "IN_PROGRESS")).toBe(true);
    expect(canTransitionAppointmentStatus("IN_PROGRESS", "COMPLETED")).toBe(true);
  });

  it("allows manual MISSED from CONFIRMED, EN_ROUTE and IN_PROGRESS only", () => {
    expect(canTransitionAppointmentStatus("CONFIRMED", "MISSED")).toBe(true);
    expect(canTransitionAppointmentStatus("EN_ROUTE", "MISSED")).toBe(true);
    expect(canTransitionAppointmentStatus("IN_PROGRESS", "MISSED")).toBe(true);
    expect(canTransitionAppointmentStatus("TENTATIVE", "MISSED")).toBe(false);
    expect(canTransitionAppointmentStatus("COMPLETED", "MISSED")).toBe(false);
  });

  it("allows CANCELLED from every non-terminal status", () => {
    for (const status of ["TENTATIVE", "CONFIRMED", "EN_ROUTE", "IN_PROGRESS"] as const) {
      expect(canTransitionAppointmentStatus(status, "CANCELLED")).toBe(true);
    }
  });

  it("treats COMPLETED, MISSED and CANCELLED as terminal", () => {
    for (const status of ["COMPLETED", "MISSED", "CANCELLED"] as const) {
      expect(APPOINTMENT_TRANSITIONS[status]).toEqual([]);
      expect(allowedNextAppointmentStatuses(status)).toEqual([]);
      for (const target of APPOINTMENT_STATUSES) {
        expect(canTransitionAppointmentStatus(status, target)).toBe(false);
      }
    }
  });

  it("rejects illegal transitions (forward-only, no skipping backwards)", () => {
    expect(() => applyAppointmentTransition("TENTATIVE", "IN_PROGRESS", { now: NOW })).toThrow(ConflictError);
    expect(() => applyAppointmentTransition("CONFIRMED", "TENTATIVE", { now: NOW })).toThrow(ConflictError);
    expect(() => applyAppointmentTransition("IN_PROGRESS", "EN_ROUTE", { now: NOW })).toThrow(ConflictError);
    expect(() => applyAppointmentTransition("COMPLETED", "TENTATIVE", { now: NOW })).toThrow(ConflictError);
    // The error names the allowed set for the source status.
    try {
      applyAppointmentTransition("TENTATIVE", "MISSED", { now: NOW });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).message).toContain("TENTATIVE");
      expect((err as ConflictError).message).toContain("CONFIRMED");
    }
  });

  it("same-status is a no-op (empty fields) so callers can skip the write+audit", () => {
    expect(applyAppointmentTransition("IN_PROGRESS", "IN_PROGRESS", { now: NOW })).toEqual({});
    expect(applyAppointmentTransition("COMPLETED", "COMPLETED", { now: NOW })).toEqual({});
  });

  it("sets timestamps: actualStartAt on IN_PROGRESS, actualEndAt on COMPLETED, missedAt on MISSED", () => {
    expect(applyAppointmentTransition("CONFIRMED", "IN_PROGRESS", { now: NOW })).toEqual({
      actualStartAt: NOW,
    });
    expect(applyAppointmentTransition("IN_PROGRESS", "COMPLETED", { now: NOW })).toEqual({
      actualEndAt: NOW,
    });
    expect(applyAppointmentTransition("CONFIRMED", "MISSED", { now: NOW })).toEqual({
      missedAt: NOW,
    });
    // Cancelling sets no timestamps.
    expect(applyAppointmentTransition("TENTATIVE", "CANCELLED", { now: NOW })).toEqual({});
  });

  it("labels are human-readable", () => {
    expect(appointmentStatusLabel("TENTATIVE")).toBe("Tentative");
    expect(appointmentStatusLabel("EN_ROUTE")).toBe("En Route");
    expect(appointmentStatusLabel("IN_PROGRESS")).toBe("In Progress");
  });
});
