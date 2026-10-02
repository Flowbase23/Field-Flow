/** UI helper tests for the payments ledger (pure parsing + row actions). */
import { describe, expect, it } from "vitest";
import { parsePaymentListFilters, paymentRowActions } from "@/features/payments/payment-ui";

describe("parsePaymentListFilters", () => {
  it("accepts recognized status and method filters", () => {
    expect(parsePaymentListFilters({ status: "SUCCEEDED", method: "CASH" })).toEqual({ status: "SUCCEEDED", method: "CASH" });
  });
  it("drops malformed values so bad URLs behave like no filter", () => {
    expect(parsePaymentListFilters({ status: "HACKED", method: "x" })).toEqual({ status: undefined, method: undefined });
    expect(parsePaymentListFilters({})).toEqual({ status: undefined, method: undefined });
    expect(parsePaymentListFilters({ status: undefined, method: "CHECK" })).toEqual({ status: undefined, method: "CHECK" });
  });
});

describe("paymentRowActions", () => {
  it("offers void for PENDING (nothing has moved yet)", () => {
    const actions = paymentRowActions("PENDING");
    expect(actions.map((action) => action.status)).toEqual(["VOIDED"]);
    expect(actions[0]!.destructive).toBe(true);
  });
  it("offers refund and void for SUCCEEDED (money may reverse)", () => {
    const actions = paymentRowActions("SUCCEEDED");
    expect(actions.map((action) => action.status)).toEqual(["REFUNDED", "VOIDED"]);
    expect(actions.every((action) => action.destructive)).toBe(true);
  });
  it("offers nothing for terminal rows", () => {
    expect(paymentRowActions("FAILED")).toEqual([]);
    expect(paymentRowActions("REFUNDED")).toEqual([]);
    expect(paymentRowActions("VOIDED")).toEqual([]);
  });
});
