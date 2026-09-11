/**
 * Permission matrix tests (src/server/auth/permissions.ts) — the full
 * Role → Permission defaults plus the pure helpers. Extends (does not
 * duplicate) the top-level tests/permissions.test.ts smoke test.
 *
 * Per-org RolePermission OVERRIDE behavior (replace-not-merge semantics,
 * cross-org isolation, fallback when no rows) is covered end-to-end through
 * the requirePermission gate in tests/authorization/require-org.test.ts,
 * because permissionsFor() reads the shared db singleton.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  can,
  canChangeMembership,
  hasRole,
} from "@/server/auth/permissions";

const ROLES = [
  "OWNER",
  "ADMIN",
  "DISPATCHER",
  "TECHNICIAN",
  "OFFICE_STAFF",
  "SALES_REP",
  "CUSTOMER_PORTAL_USER",
] as const;

describe("role → permission defaults matrix", () => {
  it("defines a non-empty default set for every role", () => {
    for (const role of ROLES) {
      expect(DEFAULT_ROLE_PERMISSIONS[role].length > 0).toBe(true);
    }
  });

  it("gives OWNER and ADMIN every permission", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      for (const permission of ALL_PERMISSIONS) {
        expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain(permission);
      }
    }
  });

  it("keeps every default inside the schema's permission enum", () => {
    for (const role of ROLES) {
      for (const permission of DEFAULT_ROLE_PERMISSIONS[role]) {
        expect(ALL_PERMISSIONS).toContain(permission);
      }
    }
  });

  it("has no duplicate permissions in ALL_PERMISSIONS or any role's defaults", () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
    for (const role of ROLES) {
      const defaults = DEFAULT_ROLE_PERMISSIONS[role];
      expect(new Set(defaults).size).toBe(defaults.length);
    }
  });

  it("grants the workflow-critical permissions per role", () => {
    const grants: Array<[keyof typeof DEFAULT_ROLE_PERMISSIONS, string]> = [
      ["DISPATCHER", "JOB_ASSIGN"],
      ["DISPATCHER", "JOB_STATUS_UPDATE"],
      ["DISPATCHER", "SCHEDULE_CREATE"],
      ["DISPATCHER", "SCHEDULE_DELETE"],
      ["DISPATCHER", "DASHBOARD_READ"],
      ["TECHNICIAN", "JOB_READ"],
      ["TECHNICIAN", "JOB_STATUS_UPDATE"],
      ["TECHNICIAN", "SCHEDULE_READ"],
      ["OFFICE_STAFF", "CUSTOMER_CREATE"],
      ["OFFICE_STAFF", "CUSTOMER_DELETE"],
      ["OFFICE_STAFF", "LEAD_UPDATE"],
      ["OFFICE_STAFF", "JOB_CREATE"],
      ["OFFICE_STAFF", "DASHBOARD_READ"],
      ["SALES_REP", "CUSTOMER_READ"],
      ["SALES_REP", "LEAD_CREATE"],
      ["SALES_REP", "LEAD_UPDATE"],
      ["CUSTOMER_PORTAL_USER", "CUSTOMER_READ"],
      ["CUSTOMER_PORTAL_USER", "JOB_READ"],
      ["CUSTOMER_PORTAL_USER", "SCHEDULE_READ"],
    ];
    for (const [role, permission] of grants) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain(permission);
    }
  });

  it("enforces least privilege — lower-privilege roles do NOT get admin powers", () => {
    const denials: Array<[keyof typeof DEFAULT_ROLE_PERMISSIONS, string]> = [
      ["DISPATCHER", "MEMBERS_MANAGE"],
      ["DISPATCHER", "ORGANIZATION_UPDATE"],
      ["DISPATCHER", "CUSTOMER_DELETE"],
      ["DISPATCHER", "AUDIT_READ"],
      ["TECHNICIAN", "MEMBERS_MANAGE"],
      ["TECHNICIAN", "CUSTOMER_READ"],
      ["TECHNICIAN", "JOB_CREATE"],
      ["TECHNICIAN", "DASHBOARD_READ"],
      ["OFFICE_STAFF", "MEMBERS_MANAGE"],
      ["OFFICE_STAFF", "JOB_ASSIGN"],
      ["OFFICE_STAFF", "AUDIT_READ"],
      ["SALES_REP", "JOB_READ"],
      ["SALES_REP", "CUSTOMER_CREATE"],
      ["SALES_REP", "SCHEDULE_CREATE"],
      ["CUSTOMER_PORTAL_USER", "MEMBERS_MANAGE"],
      ["CUSTOMER_PORTAL_USER", "LEAD_READ"],
      ["CUSTOMER_PORTAL_USER", "DASHBOARD_READ"],
    ];
    for (const [role, permission] of denials) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain(permission);
    }
  });

  it("does not grant invoicing permissions that do not exist yet (Phase 2)", () => {
    const invoicePermissions = ALL_PERMISSIONS.filter(
      (permission) => permission.includes("INVOICE") || permission.includes("PAYMENT"),
    );
    expect(invoicePermissions).toEqual([]);
  });
});

describe("pure helpers", () => {
  it("hasRole checks membership in an explicit role list", () => {
    expect(hasRole("TECHNICIAN", ["TECHNICIAN", "DISPATCHER"])).toBe(true);
    expect(hasRole("OWNER", ["TECHNICIAN"])).toBe(false);
    expect(hasRole("OWNER", [])).toBe(false);
  });

  it("can checks a loaded effective-permission set", () => {
    expect(can(["JOB_READ", "JOB_UPDATE"], "JOB_UPDATE")).toBe(true);
    expect(can(["JOB_READ"], "JOB_ASSIGN")).toBe(false);
    expect(can([], "JOB_READ")).toBe(false);
  });

  it("canChangeMembership blocks self-changes only, regardless of operation", () => {
    expect(canChangeMembership("u1", "u1", "role")).toBe(false);
    expect(canChangeMembership("u1", "u1", "status")).toBe(false);
    expect(canChangeMembership("u1", "u2", "role")).toBe(true);
    expect(canChangeMembership("u1", "u2", "status")).toBe(true);
  });
});
