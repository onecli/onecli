import { db } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import { isLlmHost } from "../../lib/path-match";
import {
  evaluatePolicyOutcome,
  outcomeToDecision,
} from "../policy-translation/evaluator";
import type {
  Decision,
  NewTarget,
  PolicyRequest,
} from "../policy-translation/types";
import { deriveHasInjections } from "./injection-probe";
import { loadRulesForSimulation } from "./load-rules";
import { resolvePrincipalSet } from "./principal-set";
import { loadConnectionProviders } from "./connection-providers";
import { loadSecretHosts } from "./secret-hosts";
import { toSimRule, type SimRule } from "./sim-rule";

// The what-if simulator: evaluate a hypothetical request against the CURRENT
// rules with the same engine, inputs, and two-level composition the gateway
// enforces — without sending anything. Reads are non-transactional (an
// advisory endpoint; a concurrent publish can interleave harmlessly). The org
// side always evaluates PUBLISHED rules (org staged edits are the org page's
// concern); `includeStaged` swaps the PROJECT side to the caller-readable
// draft — "what would happen after Apply".
//
// REDACTION CONTRACT: the engine must see the org rules to answer truthfully,
// but org rule DETAILS are org-admin-only (the guardrails view's boundary).
// When an org rule decides and the viewer isn't an org admin, the response
// carries the verdict + `redacted: true` and NO name/details. Accepted,
// deliberate disclosures beyond that: the decision's modifier values (the live
// 403/429 responses already expose them to any member driving an agent — the
// simulator just makes it cheaper); the deny-default's LEVEL (a single posture
// bit); and that any member can probe verdicts at will (inherent to exposing
// the engine — the gateway answers the same questions one live request at a
// time). Visibility keys off the AUTH user — for API-key callers that is the
// key's creator, standard key-delegation semantics.

/** The deciding rule, trimmed for display — never the full targets/identities. */
export interface SimulatedRuleRef {
  logicalId: string;
  name: string;
  source: string;
  action: "allow" | "block";
  requireApproval: boolean;
  rateLimit: number | null;
  rateLimitWindow: string | null;
}

export type SimulatedDecidedBy =
  | { kind: "rule"; scope: "organization"; redacted: true }
  | { kind: "rule"; scope: "organization" | "project"; rule: SimulatedRuleRef }
  | { kind: "default"; scope: "organization" | "project"; action: "block" }
  | { kind: "none"; managed: boolean };

export interface SimulateResult {
  decision: Decision;
  decidedBy: SimulatedDecidedBy;
  inputs: {
    host: string;
    path: string;
    method: string;
    isLlmHost: boolean;
    hasInjections: boolean;
    hasInjectionsBasis: "auto" | "override";
    staged: boolean;
  };
  /** Rules whose body conditions the simulator cannot evaluate (no body
   * input) — those rules cannot match here but can match live. Counts only
   * rules where conditions actually GATE matching (network/tools targets);
   * whole-app and secret targets ignore conditions live too, so they are
   * never "skipped". Scoped to the VIEWER's visibility (org rules excluded
   * for non-admins — even their count is org-rule information). */
  bodyConditionsSkipped: number;
}

export interface SimulateInput {
  agentId: string;
  host: string;
  path?: string;
  method: string;
  includeStaged?: boolean;
  hasInjectionsOverride?: boolean;
}

/** Mirror of the gateway's `strip_port` (gateway.rs) — patterns and matching
 * are port-less; the engine sees the bare host. */
const stripPort = (host: string): string => host.split(":")[0] ?? host;

export const simulatePolicy = async (
  input: SimulateInput,
  ctx: {
    projectId: string;
    organizationId: string;
    /** Org-admin viewers see org rule details; everyone else gets redaction. */
    viewerSeesOrgRules: boolean;
  },
): Promise<SimulateResult> => {
  // The agent must belong to the caller's project — a foreign id is simply not
  // found (existence is never revealed across the fence).
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, projectId: ctx.projectId },
    select: { id: true, secretMode: true, projectId: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found.");

  const host = stripPort(input.host.trim().toLowerCase());
  const path = input.path?.trim() || "/";
  const method = input.method.trim().toUpperCase();
  const staged = input.includeStaged === true;

  const [principals, orgRows, projectRows, secretHosts, connectionProviders] =
    await Promise.all([
      resolvePrincipalSet(agent.id, ctx.projectId, ctx.organizationId),
      loadRulesForSimulation(
        { scope: "organization", organizationId: ctx.organizationId },
        "published",
      ),
      loadRulesForSimulation(
        { scope: "project", projectId: ctx.projectId },
        staged ? "draft" : "published",
      ),
      loadSecretHosts(ctx.organizationId, ctx.projectId),
      loadConnectionProviders(ctx.organizationId, ctx.projectId),
    ]);

  const simRules: SimRule[] = [...orgRows, ...projectRows].map((row) =>
    toSimRule(row, secretHosts, connectionProviders),
  );

  // Known nonstandard-input edge: the typed host is lowercased above, while
  // the gateway's `is_llm_host` runs a case-SENSITIVE contains on the raw
  // CONNECT authority — a hand-crafted UPPERCASE authority would not get the
  // LLM carve live but would here. Real clients send lowercase authorities;
  // aligning the gateway is a cutover-PR follow-up (it would touch the live
  // legacy path).
  const llm = isLlmHost(host);
  const derivedInjections =
    input.hasInjectionsOverride === undefined
      ? await deriveHasInjections(agent, ctx.organizationId, host, principals)
      : input.hasInjectionsOverride;

  const request: PolicyRequest = {
    host,
    path,
    method,
    agentId: agent.id,
    agentGroupIds: principals.agentGroupIds,
    userIds: principals.userIds,
    groupIds: principals.groupIds,
    hasInjections: derivedInjections,
    isLlmHost: llm,
  };

  const outcome = evaluatePolicyOutcome(
    simRules.map((s) => s.rule),
    request,
  );
  const decision = outcomeToDecision(outcome);

  let decidedBy: SimulatedDecidedBy;
  if (outcome.kind === "rule") {
    // The engine rules and the meta ride side by side, index-aligned by
    // construction — find the SimRule whose engine rule decided.
    const sim = simRules.find((s) => s.rule === outcome.rule);
    if (!sim) throw new Error("simulate: matched rule lost its metadata");
    if (sim.meta.scope === "organization" && !ctx.viewerSeesOrgRules) {
      decidedBy = { kind: "rule", scope: "organization", redacted: true };
    } else {
      decidedBy = {
        kind: "rule",
        scope: sim.meta.scope,
        rule: {
          logicalId: sim.meta.logicalId,
          name: sim.meta.name,
          source: sim.meta.source,
          action: sim.rule.action,
          requireApproval: sim.rule.requireApproval,
          rateLimit: sim.rule.rateLimit,
          rateLimitWindow: sim.rule.rateLimitWindow,
        },
      };
    }
  } else if (outcome.kind === "denyDefault") {
    // The Default Rule reveals nothing but the level's posture — which any
    // member already observes live (unmatched managed requests 403).
    decidedBy = { kind: "default", scope: outcome.level, action: "block" };
  } else {
    decidedBy = { kind: "none", managed: outcome.managed };
  }

  // Count only rules the VIEWER may know about: for non-admins the org rules
  // are redacted, and even their COUNT is org-rule information (a fresh project
  // would otherwise read the number straight off) — so the disclosure is scoped
  // to the viewer's visibility, not the evaluated set. And only rules whose
  // conditions actually GATE something: network/tools targets honor them;
  // whole-app and secret targets match with conditions ignored (live too), so
  // a rule with only those targets isn't "skipped" — its conditions never
  // applied in the first place.
  const conditionsGate = (t: NewTarget): boolean =>
    t.kind === "network" || (t.kind === "app" && t.tools.length > 0);
  const disclosable = ctx.viewerSeesOrgRules
    ? simRules
    : simRules.filter((s) => s.meta.scope === "project");
  const bodyConditionsSkipped = disclosable.filter(
    (s) =>
      s.rule.targets.some(conditionsGate) &&
      (s.rule.conditions ?? []).some(
        (c) => c.target === "body" && c.operator === "contains",
      ),
  ).length;

  return {
    decision,
    decidedBy,
    inputs: {
      host,
      path,
      method,
      isLlmHost: llm,
      hasInjections: derivedInjections,
      hasInjectionsBasis:
        input.hasInjectionsOverride === undefined ? "auto" : "override",
      staged,
    },
    bodyConditionsSkipped,
  };
};
