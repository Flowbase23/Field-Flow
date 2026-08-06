import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_PERMISSIONS, can, canChangeMembership } from "@/server/auth/permissions";
describe("permissions", () => {
 it("grants defaults", () => { expect(DEFAULT_ROLE_PERMISSIONS.OWNER).toContain("MEMBERS_MANAGE"); expect(DEFAULT_ROLE_PERMISSIONS.TECHNICIAN).toContain("JOB_STATUS_UPDATE"); expect(DEFAULT_ROLE_PERMISSIONS.TECHNICIAN).not.toContain("MEMBERS_MANAGE"); });
 it("checks can", () => { expect(can(["JOB_READ"], "JOB_READ")).toBe(true); expect(can([], "JOB_READ")).toBe(false); });
 it("blocks self changes", () => { expect(canChangeMembership("u1", "u1", "role")).toBe(false); expect(canChangeMembership("u1", "u1", "status")).toBe(false); expect(canChangeMembership("u1", "u2", "role")).toBe(true); });
});
