import { describe, expect, it } from "vitest";
import {
  organizationUpdateSchema,
  inviteMemberSchema,
  changeRoleSchema,
  setMemberActiveSchema,
  isSupportedTimezone,
  isSupportedCurrency,
} from "@/features/organizations/schemas";
import {
  ROLE_TO_CLERK_ROLE_KEY,
  clerkRoleKeyToLocalRole,
} from "@/features/organizations/clerk-roles";

const VALID_CUID = "clx1234567890abcdefghijkl";

describe("organization settings validation", () => {
  it("accepts a valid update and trims/normalizes", () => {
    const parsed = organizationUpdateSchema.parse({
      name: "  Blue Ridge Plumbing  ",
      timezone: "America/New_York",
      currency: "usd",
    });
    expect(parsed.name).toBe("Blue Ridge Plumbing");
    expect(parsed.timezone).toBe("America/New_York");
    expect(parsed.currency).toBe("USD");
  });

  it("rejects missing, empty or whitespace-only names", () => {
    expect(organizationUpdateSchema.safeParse({ name: "", timezone: "UTC", currency: "USD" }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ name: "   ", timezone: "UTC", currency: "USD" }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ timezone: "UTC", currency: "USD" }).success).toBe(false);
  });

  it("rejects names that are too long", () => {
    expect(
      organizationUpdateSchema.safeParse({ name: "x".repeat(121), timezone: "UTC", currency: "USD" }).success,
    ).toBe(false);
  });

  it("accepts common IANA timezones", () => {
    for (const tz of ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Sydney"]) {
      expect(organizationUpdateSchema.safeParse({ name: "Acme", timezone: tz, currency: "USD" }).success).toBe(true);
      expect(isSupportedTimezone(tz)).toBe(true);
    }
  });

  it("rejects invalid timezones", () => {
    expect(organizationUpdateSchema.safeParse({ name: "Acme", timezone: "Mars/Olympus", currency: "USD" }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ name: "Acme", timezone: "not-a-timezone", currency: "USD" }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ name: "Acme", timezone: "", currency: "USD" }).success).toBe(false);
    expect(isSupportedTimezone("Mars/Olympus")).toBe(false);
  });

  it("accepts 3-letter ISO 4217 currencies", () => {
    for (const code of ["USD", "EUR", "GBP", "JPY", "CAD"]) {
      expect(organizationUpdateSchema.safeParse({ name: "Acme", timezone: "UTC", currency: code }).success).toBe(true);
      expect(isSupportedCurrency(code)).toBe(true);
    }
  });

  it("rejects malformed currencies", () => {
    expect(organizationUpdateSchema.safeParse({ name: "Acme", timezone: "UTC", currency: "US" }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ name: "Acme", timezone: "UTC", currency: "USDD" }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ name: "Acme", timezone: "UTC", currency: "123" }).success).toBe(false);
    expect(organizationUpdateSchema.safeParse({ name: "Acme", timezone: "UTC", currency: "" }).success).toBe(false);
    expect(isSupportedCurrency("USDX")).toBe(false);
  });

  it("normalizes lowercase currency codes to uppercase", () => {
    const parsed = organizationUpdateSchema.parse({ name: "Acme", timezone: "UTC", currency: "usd" });
    expect(parsed.currency).toBe("USD");
  });
});

describe("membership mutation validation", () => {
  it("accepts a valid invite and normalizes the email", () => {
    const parsed = inviteMemberSchema.parse({ email: "  Tech@Example.com ", role: "TECHNICIAN" });
    expect(parsed.email).toBe("tech@example.com");
    expect(parsed.role).toBe("TECHNICIAN");
  });

  it("rejects invalid invite emails", () => {
    expect(inviteMemberSchema.safeParse({ email: "not-an-email", role: "TECHNICIAN" }).success).toBe(false);
    expect(inviteMemberSchema.safeParse({ email: "", role: "TECHNICIAN" }).success).toBe(false);
  });

  it("rejects unknown roles", () => {
    expect(changeRoleSchema.safeParse({ membershipId: VALID_CUID, role: "SUPERUSER" }).success).toBe(false);
    expect(inviteMemberSchema.safeParse({ email: "a@b.com", role: "SUPERUSER" }).success).toBe(false);
  });

  it("accepts every known role for a role change", () => {
    for (const role of ["OWNER", "ADMIN", "OFFICE_STAFF", "DISPATCHER", "TECHNICIAN", "SALES_REP", "CUSTOMER_PORTAL_USER"]) {
      expect(changeRoleSchema.safeParse({ membershipId: VALID_CUID, role }).success).toBe(true);
    }
  });

  it("rejects malformed membership ids", () => {
    expect(changeRoleSchema.safeParse({ membershipId: "nope", role: "ADMIN" }).success).toBe(false);
    expect(setMemberActiveSchema.safeParse({ membershipId: "", isActive: false }).success).toBe(false);
  });

  it("requires isActive to be a boolean", () => {
    expect(setMemberActiveSchema.safeParse({ membershipId: VALID_CUID, isActive: false }).success).toBe(true);
    expect(setMemberActiveSchema.safeParse({ membershipId: VALID_CUID, isActive: true }).success).toBe(true);
    expect(setMemberActiveSchema.safeParse({ membershipId: VALID_CUID, isActive: "yes" }).success).toBe(false);
  });
});

describe("clerk role key mapping", () => {
  it("maps every local role to an org: role key", () => {
    for (const [role, key] of Object.entries(ROLE_TO_CLERK_ROLE_KEY)) {
      expect(typeof key).toBe("string");
      expect(key.startsWith("org:")).toBe(true);
      expect(role).not.toBe("");
    }
  });

  it("round-trips roles through the reverse mapping", () => {
    expect(clerkRoleKeyToLocalRole(ROLE_TO_CLERK_ROLE_KEY.ADMIN)).toBe("ADMIN");
    expect(clerkRoleKeyToLocalRole(ROLE_TO_CLERK_ROLE_KEY.OFFICE_STAFF)).toBe("OFFICE_STAFF");
    expect(clerkRoleKeyToLocalRole(ROLE_TO_CLERK_ROLE_KEY.DISPATCHER)).toBe("DISPATCHER");
    expect(clerkRoleKeyToLocalRole(ROLE_TO_CLERK_ROLE_KEY.TECHNICIAN)).toBe("TECHNICIAN");
    expect(clerkRoleKeyToLocalRole(ROLE_TO_CLERK_ROLE_KEY.SALES_REP)).toBe("SALES_REP");
    expect(clerkRoleKeyToLocalRole(ROLE_TO_CLERK_ROLE_KEY.CUSTOMER_PORTAL_USER)).toBe("CUSTOMER_PORTAL_USER");
  });

  it("falls back to OFFICE_STAFF for unknown or missing keys", () => {
    expect(clerkRoleKeyToLocalRole("org:unknown")).toBe("OFFICE_STAFF");
    expect(clerkRoleKeyToLocalRole(undefined)).toBe("OFFICE_STAFF");
  });
});
