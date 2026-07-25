import { describe, expect, it } from "vitest";
import {
  evaluatePolicyOutcome,
  evaluateNew,
  outcomeToDecision,
} from "./evaluator";
import type { NewRule, PolicyRequest } from "./types";

// The ATTRIBUTED evaluation (step 9 visibility): `evaluatePolicyOutcome` names
// the deciding rule / Default Rule; `evaluateNew` is its collapsing wrapper, so
// the golden corpus remains the behavior proof — these tests pin only the
// attribution facets the corpus can't see (which rule/level/managed decided).

const rule = (over: Partial<NewRule>): NewRule => ({
  scope: "project",
  priority: 0,
  isDefault: false,
  source: "custom",
  name: "rule",
  identities: [],
  targets: [
    {
      kind: "network",
      hostPattern: "api.example.com",
      pathPattern: null,
      method: null,
    },
  ],
  action: "allow",
  requireApproval: false,
  rateLimit: null,
  rateLimitWindow: null,
  conditions: null,
  ...over,
});

const request = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({
  host: "api.example.com",
  path: "/v1/thing",
  method: "GET",
  agentId: "agent-1",
  hasInjections: true,
  isLlmHost: false,
  ...over,
});

const orgDefault = (action: "allow" | "block"): NewRule =>
  rule({
    scope: "organization",
    isDefault: true,
    name: `org default ${action}`,
    action,
    targets: [],
  });
const projectDefault = (action: "allow" | "block"): NewRule =>
  rule({
    scope: "project",
    isDefault: true,
    name: `project default ${action}`,
    action,
    targets: [],
  });

describe("evaluatePolicyOutcome attribution", () => {
  it("names the explicit rule that decided", () => {
    const block = rule({ name: "block-example", action: "block" });
    const outcome = evaluatePolicyOutcome(
      [block, orgDefault("allow"), projectDefault("allow")],
      request(),
    );

    expect(outcome).toEqual({ kind: "rule", rule: block });
    expect(outcomeToDecision(outcome)).toEqual({ action: "block" });
  });

  it("attributes a deny-default to the ORG default first when both block", () => {
    const od = orgDefault("block");
    const pd = projectDefault("block");
    const outcome = evaluatePolicyOutcome([od, pd], request());

    expect(outcome).toEqual({
      kind: "denyDefault",
      level: "organization",
      rule: od,
    });
    expect(outcomeToDecision(outcome)).toEqual({
      action: "block",
      byDefault: true,
    });
  });

  it("attributes a lone project default Block (allowlist mode) to the project", () => {
    const pd = projectDefault("block");
    const outcome = evaluatePolicyOutcome([orgDefault("allow"), pd], request());

    expect(outcome).toEqual({
      kind: "denyDefault",
      level: "project",
      rule: pd,
    });
  });

  it("reports an unmanaged allow (deny-defaults disarmed by the carve)", () => {
    const outcome = evaluatePolicyOutcome(
      [orgDefault("block"), projectDefault("block")],
      request({ hasInjections: false }),
    );

    expect(outcome).toEqual({ kind: "allow", managed: false });
    expect(outcomeToDecision(outcome)).toEqual({ action: "allow" });
  });

  it("reports a managed allow when every default allows", () => {
    const outcome = evaluatePolicyOutcome(
      [orgDefault("allow"), projectDefault("allow")],
      request({ host: "other.example.com" }),
    );

    expect(outcome).toEqual({ kind: "allow", managed: true });
  });

  it("collapses every arm to the exact corpus-contract decision", () => {
    // Concrete expected decisions (not just wrapper equality — evaluateNew IS
    // the composition, so a pure f(x)===f(x) loop could never fail): each arm
    // incl. the rate modifier collapses to the decision the corpus contract
    // demands.
    const cases: [NewRule[], PolicyRequest, ReturnType<typeof evaluateNew>][] =
      [
        [[rule({ action: "block" })], request(), { action: "block" }],
        [
          [orgDefault("block")],
          request(),
          { action: "block", byDefault: true },
        ],
        [
          [orgDefault("allow")],
          request({ isLlmHost: true }),
          { action: "allow" },
        ],
        [
          [rule({ requireApproval: true })],
          request(),
          { action: "allow", requireApproval: true },
        ],
        [
          [rule({ rateLimit: 5, rateLimitWindow: "minute" })],
          request(),
          { action: "allow", rateLimit: 5, rateLimitWindow: "minute" },
        ],
      ];
    for (const [rules, req, expected] of cases) {
      expect(evaluateNew(rules, req)).toEqual(expected);
      expect(outcomeToDecision(evaluatePolicyOutcome(rules, req))).toEqual(
        expected,
      );
    }
  });
});
