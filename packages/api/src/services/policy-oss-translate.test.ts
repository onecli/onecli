import { describe, expect, it } from "vitest";
import {
  collapseOssAction,
  isOssBlocklistRow,
  ossAppToolProvider,
  ossCanonRule,
  ossProjectDefaultRule,
  ossRuleOrderComparator,
  translateOssBlocklistRows,
  translateOssEquipment,
  translateOssProjectRules,
  translateOssRow,
  type OssOldRule,
} from "./policy-oss-translate";

const row = (over: Partial<OssOldRule> = {}): OssOldRule => ({
  id: "r1",
  name: "rule",
  agentId: null,
  hostPattern: "api.example.com",
  pathPattern: null,
  method: null,
  action: "allow",
  enabled: true,
  rateLimit: null,
  rateLimitWindow: null,
  metadata: null,
  conditions: null,
  ...over,
});

describe("collapseOssAction", () => {
  it("collapses the four legacy actions to the v2 binary + modifiers", () => {
    expect(collapseOssAction(row({ action: "block" }))).toMatchObject({
      action: "block",
    });
    expect(collapseOssAction(row({ action: "manual_approval" }))).toMatchObject(
      { action: "allow", requireApproval: true },
    );
    expect(
      collapseOssAction(
        row({ action: "rate_limit", rateLimit: 5, rateLimitWindow: "hour" }),
      ),
    ).toMatchObject({ action: "allow", rateLimit: 5, rateLimitWindow: "hour" });
    expect(collapseOssAction(row({ action: "allow" }))).toMatchObject({
      action: "allow",
      requireApproval: false,
      rateLimit: null,
    });
  });

  it("drops malformed rate rows and unknown actions (the gateway drops them too)", () => {
    expect(
      collapseOssAction(row({ action: "rate_limit", rateLimit: 0 })),
    ).toBeNull();
    expect(
      collapseOssAction(
        row({ action: "rate_limit", rateLimit: 5, rateLimitWindow: "week" }),
      ),
    ).toBeNull();
    expect(collapseOssAction(row({ action: "warn" }))).toBeNull();
  });
});

describe("translateOssRow", () => {
  it("carries host/path/method verbatim as one network target", () => {
    const r = translateOssRow(
      row({ pathPattern: "/v1/*", method: "POST", agentId: "a1" }),
    );
    expect(r?.targets).toEqual([
      {
        kind: "network",
        hostPattern: "api.example.com",
        pathPattern: "/v1/*",
        method: "POST",
      },
    ]);
    expect(r?.identities).toEqual([{ type: "agent", id: "a1" }]);
  });

  it("app-permission tool rows become plain CUSTOM network rules (adopted at translation)", () => {
    const r = translateOssRow(
      row({
        metadata: {
          source: "app_permission",
          provider: "gmail",
          toolId: "send_email",
        },
        hostPattern: "gmail.googleapis.com",
        pathPattern: "/gmail/v1/users/*/messages/send",
        method: "POST",
        action: "block",
      }),
    );
    expect(r?.source).toBe("custom");
    expect(r?.targets[0]).toMatchObject({
      kind: "network",
      hostPattern: "gmail.googleapis.com",
    });
  });

  it("blocklist rows keep source blocklist (bridge-owned)", () => {
    const bl = row({
      metadata: {
        source: "app_permission",
        type: "blocklist",
        provider: "github",
        hostId: "uploads",
      },
      action: "block",
    });
    expect(isOssBlocklistRow(bl)).toBe(true);
    expect(translateOssRow(bl)?.source).toBe("blocklist");
  });

  it("passes behavioral conditions through verbatim", () => {
    const conditions = [
      { target: "body", operator: "contains", value: "delete" },
    ];
    expect(translateOssRow(row({ conditions }))?.conditions).toEqual(
      conditions,
    );
  });
});

describe("translateOssProjectRules ordering", () => {
  it("agent-scoped rules sort above all-agents, then by strictness, stable on input order", () => {
    const rules = translateOssProjectRules([
      row({ id: "any-allow", name: "any-allow", action: "allow" }),
      row({ id: "any-block", name: "any-block", action: "block" }),
      row({ id: "agent-allow", name: "agent-allow", agentId: "a1" }),
      row({ id: "any-block-2", name: "any-block-2", action: "block" }),
      row({
        id: "agent-rate",
        name: "agent-rate",
        agentId: "a1",
        action: "rate_limit",
        rateLimit: 10,
        rateLimitWindow: "minute",
      }),
    ]);
    expect(rules.map((r) => r.name)).toEqual([
      "agent-rate", // agent + rate (2) beats agent + allow (3)
      "agent-allow",
      "any-block", // all-agents: strictness, stable
      "any-block-2",
      "any-allow",
    ]);
    expect(rules.map((r) => r.priority)).toEqual([0, 1, 2, 3, 4]);
  });

  it("carries disabled custom rows with enabled:false but never derives disabled blocklist rows", () => {
    const rules = translateOssProjectRules([
      row({ id: "off", name: "off", enabled: false }),
      row({
        id: "bl-off",
        name: "bl-off",
        enabled: false,
        metadata: { type: "blocklist" },
        action: "block",
      }),
    ]);
    expect(rules.map((r) => r.name)).toEqual(["off"]);
    expect(rules[0]?.enabled).toBe(false);
  });
});

describe("translateOssProjectRules app-tool grouping", () => {
  const tool = (
    id: string,
    provider: string,
    toolId: string,
    over: Partial<OssOldRule> = {},
  ): OssOldRule =>
    row({
      id,
      name: `${provider} ${toolId}`,
      hostPattern: `${provider}.example.com`,
      metadata: { source: "app_permission", provider, toolId },
      ...over,
    });

  it("exposes the tool-row predicate (blocklist rows never match — no toolId)", () => {
    expect(ossAppToolProvider(tool("t", "gmail", "send_email"))).toBe("gmail");
    expect(ossAppToolProvider(row())).toBeNull();
    expect(
      ossAppToolProvider(
        row({
          metadata: {
            source: "app_permission",
            type: "blocklist",
            provider: "github",
            hostId: "uploads",
          },
        }),
      ),
    ).toBeNull();
  });

  it("groups same-signature tool rows of one app into one rule: display name, verbatim deduped targets", () => {
    const rules = translateOssProjectRules([
      tool("g1", "gmail", "send_email", {
        pathPattern: "/send",
        method: "POST",
      }),
      tool("g2", "gmail", "read_email", {
        pathPattern: "/read",
        method: "GET",
      }),
      tool("g3", "gmail", "read_email", {
        pathPattern: "/read",
        method: "GET",
      }),
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe("Gmail");
    expect(rules[0]?.source).toBe("custom");
    expect(rules[0]?.enabled).toBe(true);
    expect(rules[0]?.targets).toEqual([
      {
        kind: "network",
        hostPattern: "gmail.example.com",
        pathPattern: "/send",
        method: "POST",
      },
      {
        kind: "network",
        hostPattern: "gmail.example.com",
        pathPattern: "/read",
        method: "GET",
      },
    ]);
  });

  it("splits groups on provider, agent, action (with name suffixes), and conditions", () => {
    const conditions = [{ target: "body", operator: "contains", value: "x" }];
    const rules = translateOssProjectRules([
      tool("a1", "gmail", "t1", { pathPattern: "/1" }),
      tool("a2", "gmail", "t2", { pathPattern: "/2" }),
      tool("b1", "github", "t1", { pathPattern: "/1" }),
      tool("b2", "github", "t2", { pathPattern: "/2" }),
      tool("c1", "gmail", "t3", { agentId: "agent-1", pathPattern: "/3" }),
      tool("c2", "gmail", "t4", { agentId: "agent-1", pathPattern: "/4" }),
      tool("d1", "gmail", "t5", { action: "block", pathPattern: "/5" }),
      tool("d2", "gmail", "t6", { action: "block", pathPattern: "/6" }),
      tool("e1", "gmail", "t7", {
        action: "manual_approval",
        pathPattern: "/7",
      }),
      tool("e2", "gmail", "t8", {
        action: "manual_approval",
        pathPattern: "/8",
      }),
      tool("f1", "gmail", "t9", { conditions, pathPattern: "/9" }),
      tool("f2", "gmail", "t10", { conditions, pathPattern: "/10" }),
    ]);
    const names = rules.map((r) => r.name).sort();
    expect(names).toEqual([
      "GitHub",
      "Gmail",
      "Gmail",
      "Gmail",
      "Gmail (approval)",
      "Gmail (blocked)",
    ]);
    const agentScoped = rules.find((r) => r.identities.length > 0);
    expect(agentScoped?.identities).toEqual([{ type: "agent", id: "agent-1" }]);
    expect(agentScoped?.targets).toHaveLength(2);
    const conditioned = rules.find((r) => r.conditions !== null);
    expect(conditioned?.conditions).toEqual(conditions);
    expect(conditioned?.targets).toHaveLength(2);
  });

  it("keeps disabled, rate, malformed, and singleton tool rows per-row (byte-identical to the ungrouped translation)", () => {
    const rules = translateOssProjectRules([
      tool("g1", "gmail", "send", { pathPattern: "/send" }),
      tool("off1", "gmail", "a", { enabled: false, pathPattern: "/a" }),
      tool("off2", "gmail", "b", { enabled: false, pathPattern: "/b" }),
      tool("r1", "gmail", "c", {
        action: "rate_limit",
        rateLimit: 5,
        rateLimitWindow: "hour",
        pathPattern: "/c",
      }),
      tool("r2", "gmail", "d", {
        action: "rate_limit",
        rateLimit: 5,
        rateLimitWindow: "hour",
        pathPattern: "/d",
      }),
      tool("m1", "gmail", "e", { action: "rate_limit", rateLimit: 0 }),
    ]);
    // Singleton "gmail send" keeps its own name; the two disabled rows are
    // carried per-row; the two valid rate rows stay per-row (per-row buckets);
    // the malformed rate row is dropped.
    expect(rules.map((r) => r.name).sort()).toEqual([
      "gmail a",
      "gmail b",
      "gmail c",
      "gmail d",
      "gmail send",
    ]);
    expect(rules.filter((r) => r.enabled === false)).toHaveLength(2);
    expect(rules.filter((r) => r.rateLimit !== null)).toHaveLength(2);
  });

  it("falls back to the raw provider id when the app is unknown to the registry", () => {
    const rules = translateOssProjectRules([
      tool("x1", "acme-internal", "t1", { pathPattern: "/1" }),
      tool("x2", "acme-internal", "t2", { pathPattern: "/2" }),
    ]);
    expect(rules[0]?.name).toBe("acme-internal");
  });

  it("leaves blocklist rows untouched (including the source-app_permission blocklist shape)", () => {
    const rules = translateOssProjectRules([
      tool("g1", "github", "t1", { pathPattern: "/1" }),
      tool("g2", "github", "t2", { pathPattern: "/2" }),
      row({
        id: "bl",
        name: "bl",
        action: "block",
        metadata: {
          source: "app_permission",
          type: "blocklist",
          provider: "github",
          hostId: "uploads",
        },
      }),
    ]);
    expect(rules.map((r) => [r.name, r.source]).sort()).toEqual([
      ["GitHub", "custom"],
      ["bl", "blocklist"],
    ]);
  });

  it("slots the grouped rule at its first member's position (stable within the band)", () => {
    const rules = translateOssProjectRules([
      row({ id: "c1", name: "c1" }),
      tool("t1", "gmail", "a", { pathPattern: "/a" }),
      row({ id: "c2", name: "c2" }),
      tool("t2", "gmail", "b", { pathPattern: "/b" }),
    ]);
    expect(rules.map((r) => r.name)).toEqual(["c1", "Gmail", "c2"]);
    expect(rules.map((r) => r.priority)).toEqual([0, 1, 2]);
  });
});

describe("translateOssBlocklistRows", () => {
  it("derives only ENABLED blocklist rows, untouched order", () => {
    const rules = translateOssBlocklistRows([
      row({ name: "custom" }),
      row({ name: "bl-on", metadata: { type: "blocklist" }, action: "block" }),
      row({
        name: "bl-off",
        enabled: false,
        metadata: { type: "blocklist" },
        action: "block",
      }),
    ]);
    expect(rules.map((r) => r.name)).toEqual(["bl-on"]);
    expect(rules[0]?.source).toBe("blocklist");
  });
});

describe("ossProjectDefaultRule", () => {
  it("maps the org-row policyMode to the project Default Rule action", () => {
    expect(ossProjectDefaultRule("allow")).toMatchObject({
      isDefault: true,
      source: "default",
      action: "allow",
    });
    expect(ossProjectDefaultRule("deny").action).toBe("block");
  });
});

describe("translateOssEquipment", () => {
  it("derives selective agents' secrets + connections; all-mode agents derive nothing", () => {
    const { rules } = translateOssEquipment([
      {
        agentId: "sel",
        secretMode: "selective",
        secretIds: ["s1"],
        connections: [{ appConnectionId: "c1", sessionPolicy: null }],
      },
      {
        agentId: "all",
        secretMode: "all",
        secretIds: ["s2"],
        connections: [{ appConnectionId: "c2", sessionPolicy: null }],
      },
    ]);
    expect(rules).toHaveLength(2);
    expect(rules.every((r) => r.source === "equipment")).toBe(true);
    expect(rules.every((r) => r.identities[0]?.id === "sel")).toBe(true);
    expect(rules.map((r) => r.targets[0]?.kind).sort()).toEqual([
      "connection",
      "secret",
    ]);
  });

  it("drops stored sessionPolicy values and reports each drop", () => {
    const { rules, droppedSessionPolicies } = translateOssEquipment([
      {
        agentId: "a1",
        secretMode: "selective",
        secretIds: [],
        connections: [
          { appConnectionId: "c1", sessionPolicy: { repositories: ["o/r"] } },
          { appConnectionId: "c2", sessionPolicy: {} },
        ],
      },
    ]);
    expect(rules).toHaveLength(2);
    expect(rules.every((r) => r.conditions === null)).toBe(true);
    expect(droppedSessionPolicies).toEqual([
      { agentId: "a1", appConnectionId: "c1" },
    ]);
  });
});

describe("ossCanonRule", () => {
  it("is order-insensitive on identities and targets, sensitive on decisions", () => {
    const a = translateOssRow(row({ agentId: "a1" }));
    const b = translateOssRow(row({ agentId: "a1" }));
    expect(a && b && ossCanonRule(a)).toBe(b && ossCanonRule(b));
    const c = translateOssRow(row({ agentId: "a1", action: "block" }));
    expect(a && c && ossCanonRule(a)).not.toBe(c && ossCanonRule(c));
  });

  it("comparator is exported for the bridge's pinned merge", () => {
    const agent = translateOssRow(row({ agentId: "a1" }));
    const any = translateOssRow(row({}));
    expect(agent && any && ossRuleOrderComparator(agent, any)).toBeLessThan(0);
  });
});
