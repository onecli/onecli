import { describe, expect, it } from "vitest";
import type { BackfillRuleInput } from "../policy-service";
import { reconstructOssRule } from "./read-legacy";
import { ossCanonRule, translateOssRow } from "./translate";

const rule = (over: Partial<BackfillRuleInput>): BackfillRuleInput => ({
  priority: 0,
  isDefault: false,
  source: "custom",
  name: "r",
  action: "allow",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [],
  targets: [
    { kind: "network", hostPattern: "a.com", pathPattern: null, method: null },
  ],
  ...over,
});

describe("reconstructOssRule", () => {
  it("round-trips a translated network rule through the stored-row shape canonically", () => {
    const translated = translateOssRow({
      id: "old1",
      name: "block admin",
      agentId: "a1",
      hostPattern: "api.example.com",
      pathPattern: "/admin/*",
      method: "POST",
      action: "block",
      enabled: true,
      rateLimit: null,
      rateLimitWindow: null,
      metadata: null,
      conditions: [{ target: "body", operator: "contains", value: "x" }],
    });
    if (!translated) throw new Error("expected a translation");
    translated.priority = 3;
    const stored = {
      id: "v2-row",
      priority: 3,
      isDefault: false,
      source: "custom",
      name: "block admin",
      description: null,
      action: "block",
      rateLimit: null,
      rateLimitWindow: null,
      requireApproval: false,
      enabled: true,
      conditions: [{ target: "body", operator: "contains", value: "x" }],
      identities: [
        { agentId: "a1", agentGroupId: null, userId: null, groupId: null },
      ],
      targets: [
        {
          kind: "network",
          appProvider: null,
          appTools: [],
          appConnectionScope: null,
          appConnectionId: null,
          secretId: null,
          secretScope: null,
          hostPattern: "api.example.com",
          pathPattern: "/admin/*",
          method: "POST",
        },
      ],
    };
    expect(ossCanonRule(reconstructOssRule(stored))).toBe(
      ossCanonRule(translated),
    );
  });

  it("canon is key-order-insensitive on conditions (jsonb normalization)", () => {
    const a = rule({
      conditions: [{ target: "body", operator: "contains", value: "x" }],
    });
    const b = rule({
      conditions: [{ value: "x", operator: "contains", target: "body" }],
    });
    expect(ossCanonRule(a)).toBe(ossCanonRule(b));
  });
});
