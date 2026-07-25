import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateNew } from "./evaluator";
import type {
  Decision,
  NewIdentity,
  NewRule,
  NewTarget,
  PolicyRequest,
} from "./types";

// The v2-native correctness suite for the first-match evaluator (`evaluateNew`):
// the golden corpus (shared byte-for-byte with the Rust engine) plus
// per-dimension blocks (directory identities, empty/secret/whole-app targets,
// the uniform per-level default law), each asserted against a hand-computed
// expectation.

const canonical = (d: Decision): Decision => ({
  action: d.action,
  ...(d.requireApproval ? { requireApproval: true } : {}),
  ...(d.rateLimit != null ? { rateLimit: d.rateLimit } : {}),
  ...(d.rateLimitWindow != null ? { rateLimitWindow: d.rateLimitWindow } : {}),
  ...(d.byDefault ? { byDefault: true } : {}),
});

// ── 1 · Golden corpus (v2-native static JSON, also run by the Rust engine) ───
// Authored `NewRule` sets run straight through the first-match evaluator (the
// surviving path). The SAME JSON is `include_str!`'d + run by the Rust
// `corpus_test`, so both ports stay locked to one hand-computed `expected` — the
// cross-port parity fence, now independent of the retired old→new translators.

interface CorpusCase {
  name: string;
  rules: NewRule[];
  request: PolicyRequest;
  expected: Decision;
}

const corpusPath = fileURLToPath(
  new URL("./corpus/policy-cases.json", import.meta.url),
);
// JSON boundary: the file is validated by the assertions below, not by a schema.
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusCase[];

describe("golden corpus", () => {
  for (const c of corpus) {
    it(c.name, () =>
      expect(canonical(evaluateNew(c.rules, c.request))).toEqual(
        canonical(c.expected),
      ),
    );
  }
});

// ── 1b · Directory-identity matching (step 6, engine-only) ───────────────────
// The old oracle can't express a directory-identity rule (the old model is
// agent-only), so identity matching is validated against the engine directly —
// the lockstep twin of the Rust `directory_identity_rule_matches_via_principal_set`.

describe("directory-identity matching (step 6)", () => {
  const v2Rule = (identities: NewIdentity[], isDefault: boolean): NewRule => ({
    scope: "organization",
    priority: isDefault ? 100 : 1,
    isDefault,
    source: isDefault ? "default" : "custom",
    name: "rule",
    identities,
    targets: [
      { kind: "network", hostPattern: "*", pathPattern: "*", method: null },
    ],
    action: isDefault ? "allow" : "block",
    requireApproval: false,
    rateLimit: null,
    rateLimitWindow: null,
    conditions: null,
  });

  // A block rule for group g1 + a permissive org Default (non-match → allow).
  const rules: NewRule[] = [
    v2Rule([{ type: "group", id: "g1" }], false),
    v2Rule([], true),
  ];

  const req = (groupIds: string[]): PolicyRequest => ({
    host: "api.example.com",
    path: "/x",
    method: "GET",
    agentId: "a1",
    groupIds,
    hasInjections: false,
    isLlmHost: false,
  });

  it("matches an agent whose principal set includes the group", () => {
    expect(evaluateNew(rules, req(["g1"])).action).toBe("block");
  });

  it("does not match an agent lacking the group", () => {
    expect(evaluateNew(rules, req(["other"])).action).toBe("allow");
  });

  it("never matches with an empty principal set", () => {
    expect(evaluateNew(rules, req([])).action).toBe("allow");
  });
});

// ── Orphan-to-any fail-closed: empty targets match nothing (Layer 1) ─────────
// Mirror of the Rust `empty_target_non_default_rule_matches_nothing` test. A
// non-default rule with ZERO targets must match NOTHING (fail-closed) — never
// "any". A rule left target-less (its sole connection/secret target deleted → FK
// cascade) goes inert instead of matching every request. Empty IDENTITIES ("any
// agent") stay unchanged, so this isolates the TARGET axis.
describe("empty targets match nothing (Layer 1 fail-closed)", () => {
  const rule = (
    targets: NewTarget[],
    isDefault: boolean,
    action: "allow" | "block",
  ): NewRule => ({
    scope: "organization",
    priority: isDefault ? 100 : 1,
    isDefault,
    source: isDefault ? "default" : "custom",
    name: "rule",
    identities: [],
    targets,
    action,
    requireApproval: false,
    rateLimit: null,
    rateLimitWindow: null,
    conditions: null,
  });

  const request: PolicyRequest = {
    host: "api.example.com",
    path: "/anything",
    method: "GET",
    agentId: "a1",
    groupIds: [],
    hasInjections: false,
    isLlmHost: false,
  };

  it("a non-default rule with zero targets falls through to the default", () => {
    // A block rule left target-less must go inert, not block every request.
    const rules: NewRule[] = [
      rule([], false, "block"),
      rule([], true, "allow"),
    ];
    expect(evaluateNew(rules, request).action).toBe("allow");
  });

  it("the same rule with a matching wildcard target still blocks (control)", () => {
    const rules: NewRule[] = [
      rule(
        [{ kind: "network", hostPattern: "*", pathPattern: "*", method: null }],
        false,
        "block",
      ),
      rule([], true, "allow"),
    ];
    expect(evaluateNew(rules, request).action).toBe("block");
  });
});

// ── Secret targets permit their host (step 8) ────────────────────────────────
// Mirror of the Rust `secret_target_permits_its_host`. A `secret` target gates its
// resolved host — permit on allow, block on block, like an `app` target — and
// still injects at connect. The engine sees already-resolved host patterns (the
// gateway resolves secret_id / secret_scope → hosts at connect). Verifies: the
// specific + "all of the project's custom secrets" permit, the CHANGE-2 hard floor
// (a project secret can't self-authorize past the org deny-default), strictest-wins
// (an org block beats it), and fail-closed on an unresolved secret.
describe("secret targets permit their host (step 8)", () => {
  const rule = (
    scope: "organization" | "project",
    action: "allow" | "block",
    isDefault: boolean,
    targets: NewTarget[],
  ): NewRule => ({
    scope,
    priority: isDefault ? 100 : 1,
    isDefault,
    source: isDefault ? "default" : "custom",
    name: "rule",
    identities: [],
    targets,
    action,
    requireApproval: false,
    rateLimit: null,
    rateLimitWindow: null,
    conditions: null,
  });
  const secret = (...hostPatterns: string[]): NewTarget => ({
    kind: "secret",
    hostPatterns,
  });
  const denyDefault = rule("organization", "block", true, []);
  // A managed request (a secret would be injected → hasInjections) to `host`.
  const req = (host: string): PolicyRequest => ({
    host,
    path: "/v1",
    method: "GET",
    agentId: "a1",
    groupIds: [],
    hasInjections: true,
    isLlmHost: false,
  });

  it("a project secret allow cannot self-authorize past the org deny-default (CHANGE 2)", () => {
    const rules = [
      denyDefault,
      rule("project", "allow", false, [secret("google.com")]),
    ];
    expect(canonical(evaluateNew(rules, req("google.com")))).toEqual({
      action: "block",
      byDefault: true,
    });
  });

  it("an org 'all project secrets' allow permits a project secret's host", () => {
    const rules = [
      rule("organization", "allow", false, [
        secret("google.com", "stripe.com"),
      ]),
      denyDefault,
    ];
    expect(evaluateNew(rules, req("google.com")).action).toBe("allow");
  });

  it("a specific org secret allow permits exactly its host", () => {
    const rules = [
      rule("organization", "allow", false, [secret("google.com")]),
      denyDefault,
    ];
    expect(evaluateNew(rules, req("google.com")).action).toBe("allow");
  });

  it("an org block on the secret's host beats a project secret allow (strictest-wins)", () => {
    const rules = [
      rule("organization", "block", false, [secret("google.com")]),
      rule("project", "allow", false, [secret("google.com")]),
    ];
    expect(evaluateNew(rules, req("google.com")).action).toBe("block");
  });

  it("an unresolved secret (empty hosts) matches nothing (fail-closed)", () => {
    const rules = [denyDefault, rule("project", "allow", false, [secret()])];
    expect(canonical(evaluateNew(rules, req("google.com")))).toEqual({
      action: "block",
      byDefault: true,
    });
  });

  it("'all project secrets' permits only the project's secret hosts, not others", () => {
    const rules = [
      rule("organization", "allow", false, [
        secret("google.com", "stripe.com"),
      ]),
      denyDefault,
    ];
    expect(canonical(evaluateNew(rules, req("evil.example.com")))).toEqual({
      action: "block",
      byDefault: true,
    });
  });
});

// ── Whole-app targets permit their provider's hosts (step-8 symmetry closed) ──
// Mirror of the Rust `app_scope_and_connection_targets_permit_their_provider_hosts`.
// An `app` target with NO tools (the dialog's "All connections at a level" — and
// the bare provider-only API shape) matches HOST-ONLY against every catalog tool
// host of the provider — any path/method, unconditionally — exactly like a
// `secret` target. `connectionScope` is injection-only (never affects matching).
// An unrewritten `connection` target stays inert (unresolved — fail-closed).
describe("whole-app targets permit their provider's hosts", () => {
  const rule = (
    scope: "organization" | "project",
    action: "allow" | "block",
    isDefault: boolean,
    targets: NewTarget[],
  ): NewRule => ({
    scope,
    priority: isDefault ? 100 : 1,
    isDefault,
    source: isDefault ? "default" : "custom",
    name: "rule",
    identities: [],
    targets,
    action,
    requireApproval: false,
    rateLimit: null,
    rateLimitWindow: null,
    conditions: null,
  });
  const wholeApp = (
    provider: string,
    connectionScope: "organization" | "project" | null = "project",
  ): NewTarget => ({ kind: "app", provider, tools: [], connectionScope });
  const denyDefault = (scope: "organization" | "project") =>
    rule(scope, "block", true, []);
  const allowDefault = (scope: "organization" | "project") =>
    rule(scope, "allow", true, []);
  // A managed request (a credential would be injected → the defaults enforce).
  const req = (host: string, path = "/gmail/v1/messages"): PolicyRequest => ({
    host,
    path,
    method: "GET",
    agentId: "a1",
    groupIds: [],
    hasInjections: true,
    isLlmHost: false,
  });

  it("the user-reported shape: a project 'allow gmail · all connections' permits gmail's host in allowlist mode", () => {
    const rules = [
      allowDefault("organization"),
      rule("project", "allow", false, [wholeApp("gmail")]),
      denyDefault("project"),
    ];
    expect(evaluateNew(rules, req("gmail.googleapis.com")).action).toBe(
      "allow",
    );
  });

  it("the permit surface is exactly the provider's catalog hosts", () => {
    const rules = [
      allowDefault("organization"),
      rule("project", "allow", false, [wholeApp("gmail")]),
      denyDefault("project"),
    ];
    expect(
      canonical(evaluateNew(rules, req("api.github.com", "/repos"))),
    ).toEqual({ action: "block", byDefault: true });
  });

  it("an org whole-app block is a real block on the provider's hosts (any path/method)", () => {
    const rules = [
      rule("organization", "block", false, [
        wholeApp("github", "organization"),
      ]),
      allowDefault("organization"),
    ];
    expect(
      evaluateNew(rules, req("api.github.com", "/anything/at/all")).action,
    ).toBe("block");
  });

  it("a project whole-app allow cannot self-authorize past the org deny-default (CHANGE 2)", () => {
    const rules = [
      denyDefault("organization"),
      rule("project", "allow", false, [wholeApp("gmail")]),
    ];
    expect(canonical(evaluateNew(rules, req("gmail.googleapis.com")))).toEqual({
      action: "block",
      byDefault: true,
    });
  });

  it("connectionScope never affects matching (bare and org-scoped shapes match identically)", () => {
    for (const scope of [null, "organization"] as const) {
      const rules = [
        allowDefault("organization"),
        rule("project", "allow", false, [wholeApp("gmail", scope)]),
        denyDefault("project"),
      ];
      expect(evaluateNew(rules, req("gmail.googleapis.com")).action).toBe(
        "allow",
      );
    }
  });

  it("a catalog-less provider permits nothing (fail-closed)", () => {
    const rules = [
      allowDefault("organization"),
      rule("project", "allow", false, [wholeApp("no_such_provider")]),
      denyDefault("project"),
    ];
    expect(canonical(evaluateNew(rules, req("gmail.googleapis.com")))).toEqual({
      action: "block",
      byDefault: true,
    });
  });

  it("an unrewritten connection target stays inert (unresolved — fail-closed)", () => {
    const rules = [
      allowDefault("organization"),
      rule("project", "allow", false, [
        { kind: "connection", connectionId: "c-gone", tools: [] },
      ]),
      denyDefault("project"),
    ];
    expect(canonical(evaluateNew(rules, req("gmail.googleapis.com")))).toEqual({
      action: "block",
      byDefault: true,
    });
  });

  it("named tools keep the exact fan-out (the whole-app branch applies only to empty tools)", () => {
    // create_issue = POST api.github.com /repos/*/*/issues — a GET to another
    // path on the same host must NOT match a tools-named target.
    const target: NewTarget = {
      kind: "app",
      provider: "github",
      tools: ["create_issue"],
      connectionScope: null,
    };
    const rules = [
      allowDefault("organization"),
      rule("project", "allow", false, [target]),
      denyDefault("project"),
    ];
    expect(
      canonical(evaluateNew(rules, req("api.github.com", "/other/path"))),
    ).toEqual({ action: "block", byDefault: true });
  });

  it("a mixed shape (tools + connectionScope) keeps tool matching — scope never widens it", () => {
    // API-authorable: tools named AND a connectionScope. Matching is the exact
    // tool fan-out (the whole-app branch applies only to EMPTY tools); the
    // scope stays injection-only.
    const target: NewTarget = {
      kind: "app",
      provider: "github",
      tools: ["create_issue"],
      connectionScope: "project",
    };
    const rules = [
      allowDefault("organization"),
      rule("project", "allow", false, [target]),
      denyDefault("project"),
    ];
    expect(
      canonical(evaluateNew(rules, req("api.github.com", "/other/path"))),
    ).toEqual({ action: "block", byDefault: true });
    expect(
      evaluateNew(
        [
          allowDefault("organization"),
          rule("project", "allow", false, [target]),
          denyDefault("project"),
        ],
        { ...req("api.github.com", "/repos/o/r/issues"), method: "POST" },
      ).action,
    ).toBe("allow");
  });

  it("modifiers compose with whole-app targets (approval / rate ride the match)", () => {
    // Structurally orthogonal (toDecision never reads targets) — pinned so a
    // future target-aware modifier can't regress silently.
    const approval = {
      ...rule("project", "allow", false, [wholeApp("gmail")]),
      requireApproval: true,
    };
    const rules = [
      allowDefault("organization"),
      approval,
      denyDefault("project"),
    ];
    expect(evaluateNew(rules, req("gmail.googleapis.com"))).toEqual({
      action: "allow",
      requireApproval: true,
    });
  });

  it("whole-app matching ignores rule conditions (the secret mirror)", () => {
    // A body-contains condition that does NOT hold must not stop a whole-app
    // match — conditions gate only network/tools targets, live and here.
    const rules = [
      allowDefault("organization"),
      {
        ...rule("project", "allow", false, [wholeApp("gmail")]),
        conditions: [
          { target: "body", operator: "contains", value: "absent-token" },
        ],
      },
      denyDefault("project"),
    ];
    expect(evaluateNew(rules, req("gmail.googleapis.com")).action).toBe(
      "allow",
    );
  });
});

// Appended to the uniform-law coverage after review: the mutation-proven gap
// (both levels matching + a project default Block) and the org-side-empty cell.
describe("uniform per-level default law — review-added cells", () => {
  const rule = (
    scope: "organization" | "project",
    action: "allow" | "block",
    isDefault: boolean,
    path: string | null,
  ): NewRule => ({
    scope,
    priority: isDefault ? 100 : 1,
    isDefault,
    source: isDefault ? "default" : "custom",
    name: "rule",
    identities: [],
    targets:
      path === null
        ? []
        : [
            {
              kind: "network",
              hostPattern: "api.example.com",
              pathPattern: path,
              method: null,
            },
          ],
    action,
    requireApproval: false,
    rateLimit: null,
    rateLimitWindow: null,
    conditions: null,
  });

  const req: PolicyRequest = {
    host: "api.example.com",
    path: "/api",
    method: "POST",
    agentId: "a1",
    groupIds: [],
    hasInjections: true,
    isLlmHost: false,
  };

  it("a matched level never consults its default — the org rate modifier survives", () => {
    const orgRate: NewRule = {
      ...rule("organization", "allow", false, "/api"),
      rateLimit: 5,
      rateLimitWindow: "minute",
    };
    const projectAllow = rule("project", "allow", false, "/api");
    const withDefault = evaluateNew(
      [orgRate, projectAllow, rule("project", "block", true, null)],
      req,
    );
    const without = evaluateNew([orgRate, projectAllow], req);
    expect(withDefault).toEqual(without);
    expect(withDefault).toEqual({
      action: "allow",
      rateLimit: 5,
      rateLimitWindow: "minute",
    });
  });

  it("a project default Block denies with no org side at all", () => {
    expect(evaluateNew([rule("project", "block", true, null)], req)).toEqual({
      action: "block",
      byDefault: true,
    });
  });
});
