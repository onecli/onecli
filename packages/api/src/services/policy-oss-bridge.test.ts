import { describe, expect, it } from "vitest";
import type { BackfillRuleInput } from "./policy-service";
import { interleaveOssDerived, reconstructOssRule } from "./policy-oss-bridge";
import { ossCanonRule, translateOssRow } from "./policy-oss-translate";

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

describe("interleaveOssDerived (the pinned merge, project arm)", () => {
  it("never permutes kept customs; a derived block slots above a looser custom, ties go to the custom", () => {
    const kept = [
      { id: "c-block", rule: rule({ action: "block", name: "c-block" }) },
      { id: "c-allow", rule: rule({ name: "c-allow" }) },
    ];
    const derived = [
      rule({ source: "blocklist", action: "block", name: "bl" }),
    ];
    const plan = interleaveOssDerived(kept, derived);
    // The derived block ties with c-block (same rank, both any-agent) → the
    // custom keeps the earlier slot; the block still lands above c-allow.
    expect(plan.customPriorities).toEqual([
      { id: "c-block", priority: 0 },
      { id: "c-allow", priority: 2 },
    ]);
    expect(plan.derivedPriorities).toEqual([1]);
  });

  it("densifies one priority per derived rule and appends after all looser customs", () => {
    const kept = [{ id: "c1", rule: rule({ action: "block" }) }];
    const derived = [
      rule({ source: "blocklist", action: "block", name: "b1" }),
      rule({ source: "blocklist", action: "block", name: "b2" }),
    ];
    const plan = interleaveOssDerived(kept, derived);
    const all = [
      ...plan.customPriorities.map((c) => c.priority),
      ...plan.derivedPriorities,
    ].sort((a, b) => a - b);
    expect(all).toEqual([0, 1, 2]);
  });

  it("an agent-scoped custom allow stays above an all-agents derived block (the agent-shadow law)", () => {
    const kept = [
      {
        id: "agent-allow",
        rule: rule({ identities: [{ type: "agent", id: "a1" }] }),
      },
    ];
    const derived = [rule({ source: "blocklist", action: "block" })];
    const plan = interleaveOssDerived(kept, derived);
    expect(plan.customPriorities[0]?.priority).toBe(0);
    expect(plan.derivedPriorities[0]).toBe(1);
  });
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
