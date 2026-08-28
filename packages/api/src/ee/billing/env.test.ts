import { describe, expect, it } from "vitest";

import { PLAN_PRICE_IDS, SALES_MANAGED_PRICE_IDS } from "./env";

describe("PLAN_PRICE_IDS", () => {
  it("covers every self-serve plan with both intervals (retired plans included for interval switches)", () => {
    expect(Object.keys(PLAN_PRICE_IDS).sort()).toEqual([
      "pro",
      "scale",
      "team",
      "team-legacy",
    ]);
    for (const prices of Object.values(PLAN_PRICE_IDS)) {
      expect(Object.keys(prices).sort()).toEqual(["month", "year"]);
    }
  });
});

describe("SALES_MANAGED_PRICE_IDS", () => {
  it("never contains unset ids (an empty string would match every missing price)", () => {
    expect(SALES_MANAGED_PRICE_IDS).not.toContain("");
  });
});
