import { afterEach, describe, expect, it } from "vitest";

import {
  ENTERPRISE_FEATURES,
  initEntitlementForTests,
  isEnterpriseFeature,
  isEntitled,
  parseEntitled,
} from "./entitlements";
import { assertEntitled, enterpriseLicenseMessage } from "./entitlements-guard";
import { ServiceError } from "../services/errors";

describe("parseEntitled", () => {
  it.each<[string | undefined, boolean]>([
    ["true", true],
    [" TRUE ", true],
    ["1", true],
    [undefined, false],
    ["", false],
    ["false", false],
    ["yes", false],
    ["0", false],
  ])("onprem: %p → %p", (raw, expected) => {
    expect(parseEntitled(raw, "onprem")).toBe(expected);
  });

  it("cloud is always entitled regardless of the flag", () => {
    expect(parseEntitled(undefined, "cloud")).toBe(true);
    expect(parseEntitled("false", "cloud")).toBe(true);
    expect(parseEntitled("garbage", "cloud")).toBe(true);
  });
});

describe("isEntitled test override", () => {
  afterEach(() => initEntitlementForTests(null));

  it("honors the override in both directions", () => {
    initEntitlementForTests(true);
    expect(isEntitled()).toBe(true);
    initEntitlementForTests(false);
    expect(isEntitled()).toBe(false);
  });
});

describe("isEnterpriseFeature", () => {
  it("narrows registry keys and rejects everything else", () => {
    for (const key of Object.keys(ENTERPRISE_FEATURES)) {
      expect(isEnterpriseFeature(key)).toBe(true);
    }
    // Plan-only features must NOT be enterprise keys — deny-mode, approvals
    // and rate limits stay free on self-host by decision (#44/45/46).
    expect(isEnterpriseFeature("policy.deny_mode")).toBe(false);
    expect(isEnterpriseFeature("policy.manual_approval")).toBe(false);
    expect(isEnterpriseFeature("policy.rate_limit")).toBe(false);
  });
});

describe("assertEntitled", () => {
  afterEach(() => initEntitlementForTests(null));

  it("passes when entitled", () => {
    initEntitlementForTests(true);
    expect(() => assertEntitled("groups")).not.toThrow();
  });

  it("throws FORBIDDEN with the license message when not entitled", () => {
    initEntitlementForTests(false);
    try {
      assertEntitled("groups");
      expect.unreachable("assertEntitled must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("FORBIDDEN");
      expect((err as ServiceError).message).toBe(
        enterpriseLicenseMessage("groups"),
      );
      expect((err as ServiceError).message).toContain("Enterprise license");
    }
  });
});
