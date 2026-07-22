import { afterEach, describe, expect, it } from "vitest";
import { bridgeDerivedSources, policyEditingEnabled } from "./policy-flags";

// The kept/derived partition is keyed on ONE list — every keep-filter is its
// complement — so these pin the list per era. Editing OFF (OSS + pre-cutover
// cloud): the bridge owns app_permission/blocklist/equipment. Editing ON
// (post-adoption): app_permission is user-owned (adopted as custom) and leaves
// the derived set; the bridge derives only blocklist/equipment.

const original = process.env.POLICY_EDITING_ENABLED;

afterEach(() => {
  if (original === undefined) delete process.env.POLICY_EDITING_ENABLED;
  else process.env.POLICY_EDITING_ENABLED = original;
});

describe("bridgeDerivedSources", () => {
  it("editing OFF → the full legacy derived set", () => {
    process.env.POLICY_EDITING_ENABLED = "";
    expect(policyEditingEnabled()).toBe(false);
    expect(bridgeDerivedSources()).toEqual([
      "app_permission",
      "blocklist",
      "equipment",
    ]);
  });

  it("editing ON → app_permission leaves the derived set (adopted)", () => {
    process.env.POLICY_EDITING_ENABLED = "1";
    expect(policyEditingEnabled()).toBe(true);
    expect(bridgeDerivedSources()).toEqual(["blocklist", "equipment"]);
  });

  it("never derives custom or default in either era", () => {
    for (const flag of ["", "1"]) {
      process.env.POLICY_EDITING_ENABLED = flag;
      expect(bridgeDerivedSources()).not.toContain("custom");
      expect(bridgeDerivedSources()).not.toContain("default");
    }
  });
});

// Step 9.5 (release-as-cutover): with POLICY_EDITING_ENABLED unset, the default
// resolves by edition — ON everywhere except cloud, whose deploys set the flag
// explicitly. An explicit value always beats the edition default (the rollback
// switch).
describe("policyEditingEnabled edition defaults", () => {
  const originalEdition = process.env.EDITION;
  const originalPublicEdition = process.env.NEXT_PUBLIC_EDITION;

  afterEach(() => {
    if (originalEdition === undefined) delete process.env.EDITION;
    else process.env.EDITION = originalEdition;
    if (originalPublicEdition === undefined)
      delete process.env.NEXT_PUBLIC_EDITION;
    else process.env.NEXT_PUBLIC_EDITION = originalPublicEdition;
  });

  const unsetFlag = () => {
    delete process.env.POLICY_EDITING_ENABLED;
  };

  it.each([
    ["oss", true],
    ["onprem-slim", true],
    ["onprem-full", true],
    ["cloud", false],
    ["", true], // unset edition parses as oss
  ])("unset flag + edition %s → %s", (edition, expected) => {
    unsetFlag();
    delete process.env.NEXT_PUBLIC_EDITION;
    process.env.EDITION = edition;
    expect(policyEditingEnabled()).toBe(expected);
  });

  it("falls back to NEXT_PUBLIC_EDITION when EDITION is unset", () => {
    unsetFlag();
    delete process.env.EDITION;
    process.env.NEXT_PUBLIC_EDITION = "cloud";
    expect(policyEditingEnabled()).toBe(false);
  });

  it("an explicit flag always beats the edition default", () => {
    process.env.EDITION = "oss";
    process.env.POLICY_EDITING_ENABLED = "0";
    expect(policyEditingEnabled()).toBe(false);
    process.env.EDITION = "cloud";
    process.env.POLICY_EDITING_ENABLED = "1";
    expect(policyEditingEnabled()).toBe(true);
  });
});
