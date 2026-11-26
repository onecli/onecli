import { describe, expect, it } from "vitest";
import { approvalResultLine } from "./approval-result";

describe("approvalResultLine", () => {
  it("says a 200 that created nothing failed, with the reason", () => {
    expect(
      approvalResultLine({
        ok: false,
        succeeded: 0,
        total: 9,
        error: "BillingCountry: There's a problem with this country",
        action: "Create 9 Accounts",
      }),
    ).toEqual({
      text: "Created 0 of 9 · BillingCountry: There's a problem with this country",
      short: "Created 0 of 9",
      failed: true,
    });
  });

  it("counts a full success, and says nothing for a plain one", () => {
    expect(
      approvalResultLine({
        ok: true,
        succeeded: 3,
        total: 3,
        action: "Upsert 3 Contacts",
      }),
    ).toEqual({
      text: "Upserted 3 of 3",
      short: "Upserted 3 of 3",
      failed: false,
    });
    expect(approvalResultLine({ ok: true })).toBeUndefined();
    expect(approvalResultLine(undefined)).toBeUndefined();
  });

  it("names an uncounted failure by its error, and a count with no known verb plainly", () => {
    expect(
      approvalResultLine({ ok: false, error: "Validation Failed" }),
    ).toEqual({
      text: "It failed · Validation Failed",
      short: "It failed",
      failed: true,
    });
    // A Composite call's generic title has no verb to put in the past tense.
    expect(
      approvalResultLine({
        ok: false,
        succeeded: 1,
        total: 2,
        action: "Composite request",
      }),
    ).toEqual({
      text: "1 of 2 succeeded",
      short: "1 of 2 succeeded",
      failed: true,
    });
  });
});
