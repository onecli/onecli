// ── Policy shapes: the first-match engine's rule / request / decision types ──
// The surviving new-model shapes for the v2 evaluator, plus `OldCondition` (the
// body-condition shape, unchanged across models — still read by the endpoint
// matcher, app-catalog, and the simulator) and the shared enums.

export type RateWindow = "minute" | "hour" | "day";
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface OldCondition {
  target: string;
  operator: string;
  value: string;
  key?: string;
}

/** The request context the evaluator decides against. */
export interface PolicyRequest {
  host: string;
  path: string;
  method: string;
  /** Request body, for `body contains` conditions (cloud only). */
  body?: string;
  /** Which agent the request is from (identity + shadowing). */
  agentId: string;
  /**
   * The agent's resolved principal set (step 6): the agent-groups it belongs to,
   * and the human users + directory groups its project inherits via ProjectAccess.
   * A directory-identity rule matches iff its principal is in the matching set.
   * Optional/empty for pure-agent traffic → only agent/"any" rules match.
   */
  agentGroupIds?: string[];
  userIds?: string[];
  groupIds?: string[];
  /** A credential was injected for this host — the deny-default precondition. */
  hasInjections: boolean;
  /** Host is a known LLM provider — bypasses deny-default. */
  isLlmHost: boolean;
}

/**
 * The normalized decision produced by BOTH the oracle (old strictest-wins) and
 * the new first-match evaluator; the golden corpus asserts they agree. Old
 * actions collapse: Block→block, ManualApproval→allow+requireApproval,
 * RateLimit→allow+rateLimit, Allow→allow, BlockedByDefault→block+byDefault.
 */
export interface Decision {
  action: "allow" | "block";
  requireApproval?: boolean;
  rateLimit?: number;
  rateLimitWindow?: RateWindow;
  /** Blocked by deny-default (vs an explicit block rule). */
  byDefault?: boolean;
}

/**
 * The ATTRIBUTED result of an evaluation — which rule (or default) decided.
 * `evaluateNew` collapses this to a `Decision`; the what-if simulator keeps it
 * to name the deciding rule. Mirrors the gateway's `Outcome` (evaluate.rs).
 */
export type PolicyOutcome =
  /** An explicit rule decided (its action/modifiers are the verdict). */
  | { kind: "rule"; rule: NewRule }
  /** A Default Rule's Block decided — org-first when both levels block. */
  | {
      kind: "denyDefault";
      level: "organization" | "project";
      rule: NewRule | null;
    }
  /** Nothing matched and no default blocks. `managed` = the deny-default carve
   * was armed (credential-managed, non-LLM) but every default allows; false =
   * the request is unmanaged (or an LLM host), so deny-defaults were disarmed. */
  | { kind: "allow"; managed: boolean };

// Internal new-model shapes for the evaluator. The TRANSLATOR only ever produces
// agent or all-agents identities and app/network targets (the old model is
// agent-only; equipment is step 7). The directory kinds (agentGroup/user/group,
// step 6) are matched against the request's resolved principal set — they arrive
// on direct `PolicyRuleV2` rows, not from translation. Step 5's backfill maps
// translated rules to real `PolicyRuleV2` rows using the API's stricter enums in
// validations/policy; here the looser `method: string | null` carries an old
// row's method verbatim so the matcher stays byte-faithful.
export type NewIdentity =
  | { type: "agent"; id: string }
  | { type: "agentGroup"; id: string }
  | { type: "user"; id: string }
  | { type: "group"; id: string };

/** Where a rule came from. The retired coherence bridge re-materialized only
 * the DERIVED sources (`app_permission`/`blocklist`/`equipment`) from their live
 * source-of-truth, leaving `custom`/`default` untouched. `equipment` (step 8) is
 * the injection allowlist derived from `secretMode`/`AgentSecret`/
 * `AgentAppConnection` — connection/secret-target allow rules. */
export type RuleSource =
  | "custom"
  | "app_permission"
  | "blocklist"
  | "default"
  | "equipment";

// A `connection` target names a credential to inject — AND gates its provider's
// hosts: resolvable ones are rewritten to `app` targets carrying the target's
// own tools (empty = whole app, named = the tool fan-out) via the gateway's
// `assemble.rs` decode / the sim-rule mapper; one that reaches the evaluator
// unrewritten is UNRESOLVED (deleted/foreign connection) and never matches
// (fail-closed). A `secret` target (step 8) gates its resolved host(s) the same
// way. Both arrive on v2-authored custom rules and the equipment backfill, never
// from the old-policy translators (network/app).
export type NewTarget =
  | {
      kind: "network";
      hostPattern: string;
      pathPattern: string | null;
      method: string | null;
    }
  | {
      kind: "app";
      provider: string;
      // Named tools → the exact per-tool (host, path, method) fan-out. EMPTY →
      // the WHOLE app: host-only against all the provider's catalog tool hosts
      // (permit on allow / block on block — the secret mirror). Authored as the
      // dialog's "All connections" shape, or decoded from a resolved
      // `connection` target (which carries its own tools).
      tools: string[];
      // Step 8: "all connections at a level" injection scope; null = no
      // injection. Injection-only (the evaluator ignores it — the level picks
      // the injection pool, never the host set).
      connectionScope: "organization" | "project" | null;
    }
  | { kind: "connection"; connectionId: string; tools: string[] }
  // Step 8: a secret target gates its host — resolved (at the gateway, at connect)
  // to the secret's host pattern(s): a specific secret → its one host; a level
  // scope → the union of the org/project secrets' hosts. Permits on allow / blocks
  // on block, like `app`. Empty = unresolved (deleted) → never matches.
  | { kind: "secret"; hostPatterns: string[] };

/**
 * A translated new-model rule (a projected `PolicyRuleV2` + its identities +
 * targets). `priority` is assigned so per-level first-match reproduces
 * strictest-wins; empty identities = "any", but a non-default rule with empty
 * targets matches NOTHING (fail-closed). `isDefault` marks the org posture rule
 * (the deny/allow fallback) — the only target-less match-all.
 */
export interface NewRule {
  scope: "organization" | "project";
  priority: number;
  isDefault: boolean;
  source: RuleSource;
  name: string;
  identities: NewIdentity[];
  targets: NewTarget[];
  action: "allow" | "block";
  requireApproval: boolean;
  rateLimit: number | null;
  rateLimitWindow: RateWindow | null;
  conditions: OldCondition[] | null;
}
