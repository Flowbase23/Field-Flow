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
      ["OFFICE_STAFF", "INVOICE_READ"],
      ["OFFICE_STAFF", "INVOICE_CREATE"],
      ["OFFICE_STAFF", "INVOICE_UPDATE"],
      ["OFFICE_STAFF", "INVOICE_STATUS_UPDATE"],
      ["DISPATCHER", "INVOICE_READ"],
      ["SALES_REP", "INVOICE_READ"],
      ["OFFICE_STAFF", "ESTIMATE_READ"],
      ["OFFICE_STAFF", "ESTIMATE_CREATE"],
      ["OFFICE_STAFF", "ESTIMATE_UPDATE"],
      ["OFFICE_STAFF", "ESTIMATE_STATUS_UPDATE"],
      ["DISPATCHER", "ESTIMATE_READ"],
      ["SALES_REP", "ESTIMATE_READ"],
      ["OFFICE_STAFF", "PAYMENT_READ"],
      ["OFFICE_STAFF", "PAYMENT_CREATE"],
      ["DISPATCHER", "PAYMENT_READ"],
      ["SALES_REP", "PAYMENT_READ"],
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
      ["DISPATCHER", "INVOICE_CREATE"],
      ["DISPATCHER", "INVOICE_UPDATE"],
      ["DISPATCHER", "INVOICE_DELETE"],
      ["DISPATCHER", "INVOICE_STATUS_UPDATE"],
      ["TECHNICIAN", "INVOICE_READ"],
      ["TECHNICIAN", "INVOICE_CREATE"],
      ["OFFICE_STAFF", "INVOICE_DELETE"],
      ["SALES_REP", "INVOICE_CREATE"],
      ["SALES_REP", "INVOICE_UPDATE"],
      ["SALES_REP", "INVOICE_DELETE"],
      ["CUSTOMER_PORTAL_USER", "INVOICE_READ"],
      ["DISPATCHER", "ESTIMATE_CREATE"],
      ["DISPATCHER", "ESTIMATE_UPDATE"],
      ["DISPATCHER", "ESTIMATE_DELETE"],
      ["DISPATCHER", "ESTIMATE_STATUS_UPDATE"],
      ["TECHNICIAN", "ESTIMATE_READ"],
      ["OFFICE_STAFF", "ESTIMATE_DELETE"],
      ["SALES_REP", "ESTIMATE_CREATE"],
      ["SALES_REP", "ESTIMATE_UPDATE"],
      ["SALES_REP", "ESTIMATE_DELETE"],
      ["SALES_REP", "ESTIMATE_STATUS_UPDATE"],
      ["CUSTOMER_PORTAL_USER", "ESTIMATE_READ"],
      ["CUSTOMER_PORTAL_USER", "MEMBERS_MANAGE"],
      ["CUSTOMER_PORTAL_USER", "LEAD_READ"],
      ["CUSTOMER_PORTAL_USER", "DASHBOARD_READ"],
    ];
    for (const [role, permission] of denials) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain(permission);
    }
  });

  it("defines exactly five INVOICE_* permissions", () => {
    const invoicePermissions = ALL_PERMISSIONS.filter((permission) => permission.includes("INVOICE"));
    expect(invoicePermissions).toEqual([
      "INVOICE_READ",
      "INVOICE_CREATE",
      "INVOICE_UPDATE",
      "INVOICE_DELETE",
      "INVOICE_STATUS_UPDATE",
    ]);
  });
  it("defines exactly four PAYMENT_* permissions (Slice P2-3 — immutable ledger, no PAYMENT_UPDATE)", () => {
    const paymentPermissions = ALL_PERMISSIONS.filter((permission) => permission.includes("PAYMENT"));
    expect(paymentPermissions).toEqual([
      "PAYMENT_READ",
      "PAYMENT_CREATE",
      "PAYMENT_REFUND",
      "PAYMENT_VOID",
    ]);
  });
  it("keeps money corrections (PAYMENT_REFUND/PAYMENT_VOID) to owner/admin", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      for (const permission of ["PAYMENT_READ", "PAYMENT_CREATE", "PAYMENT_REFUND", "PAYMENT_VOID"]) {
        expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain(permission);
      }
    }
    // Office staff runs the payment desk but corrections stay above it.
    expect(DEFAULT_ROLE_PERMISSIONS.OFFICE_STAFF).not.toContain("PAYMENT_REFUND");
    expect(DEFAULT_ROLE_PERMISSIONS.OFFICE_STAFF).not.toContain("PAYMENT_VOID");
    expect(DEFAULT_ROLE_PERMISSIONS.DISPATCHER.every((permission) => !permission.startsWith("PAYMENT_") || permission === "PAYMENT_READ")).toBe(true);
    expect(DEFAULT_ROLE_PERMISSIONS.TECHNICIAN.every((permission) => !permission.includes("PAYMENT"))).toBe(true);
    expect(DEFAULT_ROLE_PERMISSIONS.CUSTOMER_PORTAL_USER.every((permission) => !permission.includes("PAYMENT"))).toBe(true);
  });
  it("keeps INVOICE_DELETE to owner/admin — office staff runs the day-to-day desk only", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      for (const permission of ["INVOICE_READ", "INVOICE_CREATE", "INVOICE_UPDATE", "INVOICE_DELETE", "INVOICE_STATUS_UPDATE"]) {
        expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain(permission);
      }
    }
    expect(DEFAULT_ROLE_PERMISSIONS.OFFICE_STAFF).not.toContain("INVOICE_DELETE");
    expect(DEFAULT_ROLE_PERMISSIONS.DISPATCHER).not.toContain("INVOICE_CREATE");
    expect(DEFAULT_ROLE_PERMISSIONS.TECHNICIAN.every((permission) => !permission.includes("INVOICE"))).toBe(true);
    expect(DEFAULT_ROLE_PERMISSIONS.CUSTOMER_PORTAL_USER.every((permission) => !permission.includes("INVOICE"))).toBe(true);
  });
  it("defines exactly five ESTIMATE_* permissions (Slice P2-2)", () => {
    const estimatePermissions = ALL_PERMISSIONS.filter((permission) => permission.includes("ESTIMATE"));
    expect(estimatePermissions).toEqual([
      "ESTIMATE_READ",
      "ESTIMATE_CREATE",
      "ESTIMATE_UPDATE",
      "ESTIMATE_DELETE",
      "ESTIMATE_STATUS_UPDATE",
    ]);
  });
  it("keeps ESTIMATE_DELETE to owner/admin and estimates read-only below office staff", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      for (const permission of ["ESTIMATE_READ", "ESTIMATE_CREATE", "ESTIMATE_UPDATE", "ESTIMATE_DELETE", "ESTIMATE_STATUS_UPDATE"]) {
        expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain(permission);
      }
    }
    expect(DEFAULT_ROLE_PERMISSIONS.OFFICE_STAFF).not.toContain("ESTIMATE_DELETE");
    expect(DEFAULT_ROLE_PERMISSIONS.DISPATCHER).not.toContain("ESTIMATE_CREATE");
    expect(DEFAULT_ROLE_PERMISSIONS.TECHNICIAN.every((permission) => !permission.includes("ESTIMATE"))).toBe(true);
    expect(DEFAULT_ROLE_PERMISSIONS.CUSTOMER_PORTAL_USER.every((permission) => !permission.includes("ESTIMATE"))).toBe(true);
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
