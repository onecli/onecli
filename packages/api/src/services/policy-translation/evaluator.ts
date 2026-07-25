import { endpointMatches } from "./endpoint-match";
import { hostMatches } from "../../lib/path-match";
import { strictnessRank } from "./strictness";
import { appTargetMatches, providerHostMatches } from "./translate/app-catalog";
import type {
  Decision,
  NewRule,
  NewTarget,
  PolicyOutcome,
  PolicyRequest,
} from "./types";

// ── The new first-match policy engine ───────────────────────────────────────
// Two-level: per-scope first-match (org, then project), combined by strictest,
// with each level's Default Rule as its fallback verdict (deny wins). This is the
// engine step 4 (shadow) and step 5 (cutover) adopt; the golden corpus asserts
// evaluateNew(translatePolicy(state)) == evaluateOracle(state).
//
// Why two levels rather than one merged list: the gateway lets a PROJECT
// agent-scoped rule shadow (loosen or tighten) a project all-agents rule, but
// NEVER lets a project rule override an org rule. A single merged first-match
// can honor at most one of "agent loosens all-agents" (needs identity to beat
// strictness) and "org is un-overridable" (needs strictness to beat identity).
// Splitting org/project and combining by strictest honors both.

const identityMatches = (rule: NewRule, request: PolicyRequest): boolean =>
  rule.identities.length === 0 ||
  rule.identities.some((i) => {
    switch (i.type) {
      case "agent":
        return i.id === request.agentId;
      case "agentGroup":
        return (request.agentGroupIds ?? []).includes(i.id);
      case "user":
        return (request.userIds ?? []).includes(i.id);
      case "group":
        return (request.groupIds ?? []).includes(i.id);
    }
  });

const targetMatches = (
  target: NewTarget,
  rule: NewRule,
  request: PolicyRequest,
): boolean => {
  switch (target.kind) {
    case "network":
      return (
        hostMatches(request.host, target.hostPattern) &&
        endpointMatches(request, {
          pathPattern: target.pathPattern ?? "*",
          method: target.method,
          conditions: rule.conditions,
        })
      );
    case "app":
      // NO tools = the WHOLE app (the dialog's "All connections" and an
      // empty-tools resolved `connection` target): host-only against every
      // catalog tool host of the provider — any path/method, conditions ignored
      // — the `secret` mirror (`catalog.rs::app_target_matches`, empty-tools
      // branch). Named tools = the fan-out (honors path/method/conditions). The
      // `connectionScope` is injection-only either way (never affects matching).
      if (target.tools.length === 0) {
        return providerHostMatches(request.host, target.provider);
      }
      return appTargetMatches(
        request,
        target.provider,
        target.tools,
        rule.conditions,
      );
    case "connection":
      // An UNRESOLVED connection target (the sim-rule mapper rewrites resolvable
      // ones to app targets carrying their tools; the gateway decodes them the
      // same way) — its connection is deleted/foreign, so it never matches
      // (fail-closed, mirrors the gateway's `Unresolved`).
      return false;
    case "secret":
      // A secret gates its host (step 8): permit on allow / block on block, like an
      // `app` target. Matches when the request host matches ANY resolved host
      // pattern (host-only, mirroring the connect-time injection filter — permit ⟺
      // inject). Empty patterns = unresolved/deleted secret → never matches.
      return target.hostPatterns.some((h) => hostMatches(request.host, h));
  }
};

// Mirror of evaluate.rs `rule_matches`: a non-default rule matches only when it
// names at least one target AND one of them matches. Empty targets = matches
// NOTHING (fail-closed) — "match everything" is the Default Rule's terminal or an
// explicit wildcard, never an empty target list. This also neutralizes an orphaned
// rule whose sole connection/secret target was deleted (the FK cascade leaves zero
// targets). Only non-default rules reach here (the default is pulled separately).
const ruleMatches = (rule: NewRule, request: PolicyRequest): boolean =>
  identityMatches(rule, request) &&
  rule.targets.length > 0 &&
  rule.targets.some((t) => targetMatches(t, rule, request));

interface LevelMatch {
  rank: number;
  rule: NewRule;
}

/** First matching rule in priority order within one scope. */
const firstMatch = (
  rules: NewRule[],
  request: PolicyRequest,
): LevelMatch | null => {
  // Stable sort by priority: equal-priority rules keep their loader order, which
  // is `ORDER BY priority, id` — so first-match matches the gateway's
  // `ORDER BY r.priority, r.id`. The row id isn't on the pure NewRule (it rides as
  // sim metadata), so the (priority, id) order is established by the loaders, not
  // re-derived here; JS Array.sort is stable, so ties are preserved.
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    if (ruleMatches(rule, request)) {
      return { rank: strictnessRank(rule), rule };
    }
  }
  return null;
};

const toDecision = (rule: NewRule): Decision => {
  if (rule.action === "block") return { action: "block" };
  if (rule.requireApproval) return { action: "allow", requireApproval: true };
  if (rule.rateLimit !== null && rule.rateLimitWindow !== null) {
    return {
      action: "allow",
      rateLimit: rule.rateLimit,
      rateLimitWindow: rule.rateLimitWindow,
    };
  }
  return { action: "allow" };
};

/**
 * Decide `request` against a translated rule set, ATTRIBUTED: the outcome names
 * the deciding rule (or Default Rule). `evaluateNew` collapses it to a bare
 * `Decision` — the corpus-gated contract — so this core IS the engine, not a
 * parallel one.
 *
 * The uniform per-level default law (step 9): each level's verdict is its first
 * matching rule, else its Default Rule; the stricter verdict wins (deny-wins).
 * A level with no rules and no Default Rule contributes no verdict.
 * Default-Block verdicts are gated by the `enforceDeny` carve (managed, non-LLM
 * requests only); explicit rule blocks are unconditional. Mirrors
 * `evaluate_outcome` (evaluate.rs).
 */
export const evaluatePolicyOutcome = (
  rules: NewRule[],
  request: PolicyRequest,
): PolicyOutcome => {
  const orgDefault = rules.find(
    (r) => r.isDefault && r.scope === "organization",
  );
  const projectDefault = rules.find(
    (r) => r.isDefault && r.scope === "project",
  );
  const orgExplicit = rules.filter(
    (r) => !r.isDefault && r.scope === "organization",
  );
  const projectExplicit = rules.filter(
    (r) => !r.isDefault && r.scope === "project",
  );

  const orgMatch = firstMatch(orgExplicit, request);
  const projectMatch = firstMatch(projectExplicit, request);

  // A Default Rule Block is a HARD FLOOR at its level: the org default's Block
  // may not be opened by a project ALLOW (only an org allow rule or an org allow
  // posture opens the door), and symmetrically a project default Block
  // (allowlist mode) may not be opened by an org ALLOW — an org allow is
  // "permission"; the project mirrors the allows it wants.
  const enforceDeny = request.hasInjections && !request.isLlmHost;
  const orgDefaultBlocks = orgDefault?.action === "block" && enforceDeny;
  const projectDefaultBlocks =
    projectDefault?.action === "block" && enforceDeny;

  // A lone org ALLOW can't punch through the project default Block (allowlist
  // mode) — drop it so it falls through to the deny-default. An org BLOCK still
  // applies (it only tightens). Approval/rate rules are action "allow", so they
  // defer too — symmetric with the org floor below.
  const effectiveOrg =
    projectMatch === null &&
    orgMatch?.rule.action === "allow" &&
    projectDefaultBlocks
      ? null
      : orgMatch;

  // A lone project ALLOW can't punch through the org default Block — drop it so it
  // falls through to the deny-default. A project BLOCK still applies (it only
  // tightens); an allow-posture org lets the project allow win.
  const effectiveProject =
    orgMatch === null &&
    projectMatch?.rule.action === "allow" &&
    orgDefaultBlocks
      ? null
      : projectMatch;

  // Combine the two level results by strictest (lower rank = stricter); on a tie
  // keep the org match (reduce's left bias) so the org rate modifier wins,
  // matching the oracle's org-first Pass 3.
  const candidates = [effectiveOrg, effectiveProject].filter(
    (m): m is LevelMatch => m !== null,
  );
  if (candidates.length > 0) {
    const best = candidates.reduce((a, b) => (b.rank < a.rank ? b : a));
    return { kind: "rule", rule: best.rule };
  }

  // No explicit rule survived → the level defaults decide; deny wins.
  // Attribution is org-first (the org default is checked first at the gateway).
  if (orgDefaultBlocks) {
    return {
      kind: "denyDefault",
      level: "organization",
      rule: orgDefault ?? null,
    };
  }
  if (projectDefaultBlocks) {
    return {
      kind: "denyDefault",
      level: "project",
      rule: projectDefault ?? null,
    };
  }
  return { kind: "allow", managed: enforceDeny };
};

/** Collapse an attributed outcome to the bare corpus-contract `Decision`. */
export const outcomeToDecision = (outcome: PolicyOutcome): Decision => {
  switch (outcome.kind) {
    case "rule":
      return toDecision(outcome.rule);
    case "denyDefault":
      return { action: "block", byDefault: true };
    case "allow":
      return { action: "allow" };
  }
};

/**
 * Decide `request` against a translated rule set — the corpus-gated contract
 * (`evaluateNew(translatePolicy(state)) == evaluateOracle(state)`). A thin
 * collapsing wrapper over `evaluatePolicyOutcome`.
 */
export const evaluateNew = (
  rules: NewRule[],
  request: PolicyRequest,
): Decision => outcomeToDecision(evaluatePolicyOutcome(rules, request));
