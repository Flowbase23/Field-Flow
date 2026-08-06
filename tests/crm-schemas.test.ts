/**
 * Pure-logic tests for the Slice 3 CRM Zod schemas (customers, locations,
 * leads) — valid inputs pass and normalize, invalid inputs are rejected.
 * No DB, no Clerk: these run in the plain node vitest environment.
 */
import { describe, expect, it } from "vitest";
import {
  customerCreateSchema,
  customerUpdateActionSchema,
  locationCreateActionSchema,
  locationUpdateActionSchema,
} from "@/features/customers/schemas";
import {
  leadCreateSchema,
  leadStatusUpdateSchema,
  leadUpdateActionSchema,
} from "@/features/leads/schemas";

const VALID_CUID = "clx1234567890abcdefghijkl";

describe("customerCreateSchema", () => {
  it("accepts a minimal valid customer and applies defaults", () => {
    const parsed = customerCreateSchema.parse({ firstName: "Jane", lastName: "Doe" });
    expect(parsed.firstName).toBe("Jane");
    expect(parsed.type).toBe("RESIDENTIAL");
    expect(parsed.email).toBeNull();
  });

  it("accepts a company customer with email/phone and normalizes", () => {
    const parsed = customerCreateSchema.parse({
      companyName: "  Acme Plumbing  ",
      email: "  JANE@ACME.COM ",
      phone: "(555) 123-4567",
    });
    expect(parsed.companyName).toBe("Acme Plumbing");
    expect(parsed.email).toBe("jane@acme.com");
    expect(parsed.phone).toBe("(555) 123-4567");
  });

  it("rejects a customer with no name at all", () => {
    expect(customerCreateSchema.safeParse({ email: "x@y.com" }).success).toBe(false);
    expect(customerCreateSchema.safeParse({}).success).toBe(false);
    expect(customerCreateSchema.safeParse({ firstName: "", lastName: "  " }).success).toBe(false);
  });

  it("rejects invalid email addresses", () => {
    expect(customerCreateSchema.safeParse({ firstName: "A", email: "not-an-email" }).success).toBe(false);
    expect(customerCreateSchema.safeParse({ firstName: "A", email: "@@" }).success).toBe(false);
  });

  it("rejects malformed phone numbers", () => {
    expect(customerCreateSchema.safeParse({ firstName: "A", phone: "abc" }).success).toBe(false);
    expect(customerCreateSchema.safeParse({ firstName: "A", phone: "123" }).success).toBe(false); // too short
  });

  it("rejects unknown customer types", () => {
    expect(customerCreateSchema.safeParse({ firstName: "A", type: "GOVERNMENT" }).success).toBe(false);
  });

  it("accepts every valid customer type", () => {
    for (const type of ["RESIDENTIAL", "COMMERCIAL", "PROPERTY_MANAGER", "OTHER"]) {
      expect(customerCreateSchema.safeParse({ firstName: "A", type }).success).toBe(true);
    }
  });
});

describe("customerUpdateActionSchema", () => {
  it("accepts a partial update with only the id and one field", () => {
    const parsed = customerUpdateActionSchema.parse({ id: VALID_CUID, notes: "prefers email" });
    expect(parsed.id).toBe(VALID_CUID);
    expect(parsed.notes).toBe("prefers email");
    // Absent keys stay absent — no defaults sneak in on update.
    expect("type" in parsed).toBe(false);
  });

  it("rejects a missing or malformed id", () => {
    expect(customerUpdateActionSchema.safeParse({ firstName: "A" }).success).toBe(false);
    expect(customerUpdateActionSchema.safeParse({ id: "nope", firstName: "A" }).success).toBe(false);
  });
});

describe("location schemas", () => {
  const validLocation = {
    label: "Warehouse",
    address1: "123 Main St",
    city: "Raleigh",
    state: "NC",
    postalCode: "27601",
  };

  it("accepts a valid location and applies defaults", () => {
    const parsed = locationCreateActionSchema.parse({ customerId: VALID_CUID, ...validLocation });
    expect(parsed.customerId).toBe(VALID_CUID);
    expect(parsed.label).toBe("Warehouse");
    expect(parsed.country).toBe("US");
    expect(parsed.timezone).toBeNull();
  });

  it("defaults the label to Primary", () => {
    const { label, ...rest } = validLocation;
    const parsed = locationCreateActionSchema.parse({ customerId: VALID_CUID, ...rest });
    expect(parsed.label).toBe("Primary");
  });

  it("rejects missing required address fields", () => {
    expect(locationCreateActionSchema.safeParse({ customerId: VALID_CUID, city: "R", state: "NC", postalCode: "27601" }).success).toBe(false);
    expect(locationCreateActionSchema.safeParse({ customerId: VALID_CUID, ...validLocation, city: "" }).success).toBe(false);
    expect(locationCreateActionSchema.safeParse({ customerId: VALID_CUID, ...validLocation, postalCode: "" }).success).toBe(false);
  });

  it("rejects out-of-range coordinates", () => {
    expect(locationCreateActionSchema.safeParse({ customerId: VALID_CUID, ...validLocation, latitude: 91 }).success).toBe(false);
    expect(locationCreateActionSchema.safeParse({ customerId: VALID_CUID, ...validLocation, latitude: -91 }).success).toBe(false);
    expect(locationCreateActionSchema.safeParse({ customerId: VALID_CUID, ...validLocation, longitude: 181 }).success).toBe(false);
    expect(locationCreateActionSchema.safeParse({ customerId: VALID_CUID, ...validLocation, longitude: -181 }).success).toBe(false);
  });

  it("accepts valid coordinates", () => {
    const parsed = locationCreateActionSchema.parse({
      customerId: VALID_CUID,
      ...validLocation,
      latitude: 35.7796,
      longitude: -78.6382,
    });
    expect(parsed.latitude).toBe(35.7796);
  });

  it("rejects malformed country codes and timezones", () => {
    expect(locationCreateActionSchema.safeParse({ customerId: VALID_CUID, ...validLocation, country: "USA" }).success).toBe(false);
    expect(locationCreateActionSchema.safeParse({ customerId: VALID_CUID, ...validLocation, country: "u" }).success).toBe(false);
    expect(locationCreateActionSchema.safeParse({ customerId: VALID_CUID, ...validLocation, timezone: "Mars/Olympus" }).success).toBe(false);
  });

  it("accepts a valid timezone and normalizes country", () => {
    const parsed = locationCreateActionSchema.parse({
      customerId: VALID_CUID,
      ...validLocation,
      country: "us",
      timezone: "America/New_York",
    });
    expect(parsed.country).toBe("US");
    expect(parsed.timezone).toBe("America/New_York");
  });

  it("update schema is partial and carries no defaults", () => {
    const parsed = locationUpdateActionSchema.parse({ id: VALID_CUID, accessNotes: "gate code 1234" });
    expect(parsed.accessNotes).toBe("gate code 1234");
    expect("label" in parsed).toBe(false);
    expect("country" in parsed).toBe(false);
  });
});

describe("leadCreateSchema", () => {
  it("accepts a valid lead and applies defaults", () => {
    const parsed = leadCreateSchema.parse({ title: "Replace water heater" });
    expect(parsed.title).toBe("Replace water heater");
    expect(parsed.source).toBe("OTHER");
    expect(parsed.status).toBe("NEW");
    expect(parsed.estimatedValueCents).toBeNull();
    expect(parsed.ownerUserId).toBeNull();
    expect(parsed.customerId).toBeNull();
  });

  it("accepts an assigned, linked, valued lead", () => {
    const parsed = leadCreateSchema.parse({
      title: "AC install",
      source: "REFERRAL",
      estimatedValueCents: 850000,
      ownerUserId: VALID_CUID,
      customerId: VALID_CUID,
      description: "2-story house",
    });
    expect(parsed.source).toBe("REFERRAL");
    expect(parsed.estimatedValueCents).toBe(850000);
  });

  it("rejects a missing or blank title", () => {
    expect(leadCreateSchema.safeParse({}).success).toBe(false);
    expect(leadCreateSchema.safeParse({ title: "" }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ title: "   " }).success).toBe(false);
  });

  it("rejects unknown sources/statuses and negative cents", () => {
    expect(leadCreateSchema.safeParse({ title: "T", source: "BILLBOARD" }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ title: "T", status: "CLOSED" }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ title: "T", estimatedValueCents: -5 }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ title: "T", estimatedValueCents: 1.5 }).success).toBe(false); // must be whole cents
  });

  it("accepts every lead source and status", () => {
    for (const source of ["WEBSITE", "PHONE", "REFERRAL", "ADVERTISEMENT", "REPEAT_CUSTOMER", "PARTNER", "OTHER"]) {
      expect(leadCreateSchema.safeParse({ title: "T", source }).success).toBe(true);
    }
    for (const status of ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATE", "WON", "LOST"]) {
      expect(leadCreateSchema.safeParse({ title: "T", status }).success).toBe(true);
    }
  });
});

describe("leadUpdateActionSchema", () => {
  it("accepts a partial edit without defaults", () => {
    const parsed = leadUpdateActionSchema.parse({ id: VALID_CUID, description: "customer called back" });
    expect(parsed.description).toBe("customer called back");
    expect("status" in parsed).toBe(false);
    expect("source" in parsed).toBe(false);
  });
});

describe("leadStatusUpdateSchema", () => {
  it("accepts any status change without a lost reason", () => {
    for (const status of ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATE", "WON"]) {
      const res = leadStatusUpdateSchema.safeParse({ id: VALID_CUID, status });
      expect(res.success).toBe(true);
    }
  });

  it("requires a lost reason when moving to LOST", () => {
    expect(leadStatusUpdateSchema.safeParse({ id: VALID_CUID, status: "LOST" }).success).toBe(false);
    expect(leadStatusUpdateSchema.safeParse({ id: VALID_CUID, status: "LOST", lostReason: "" }).success).toBe(false);
    expect(leadStatusUpdateSchema.safeParse({ id: VALID_CUID, status: "LOST", lostReason: "went with competitor" }).success).toBe(true);
  });

  it("rejects unknown statuses", () => {
    expect(leadStatusUpdateSchema.safeParse({ id: VALID_CUID, status: "ARCHIVED" }).success).toBe(false);
  });
});
