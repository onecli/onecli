import { db } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import {
  getAppPermissionDefinition,
  type AppPermissionDefinition,
} from "../../apps/app-permissions";
import { hostMatches, isLlmHost } from "../../lib/path-match";
import { allRuleVariants } from "../policy-translation/translate/app-catalog";
import { evaluatePolicyOutcome } from "../policy-translation/evaluator";
import type { NewRule, PolicyRequest } from "../policy-translation/types";
import type { ProvenanceRuleRef } from "../policy-simulate/sim-rule";
import {
  loadInjectionRules,
  loadRulesForSimulation,
} from "../policy-simulate/load-rules";
import {
  resolvePrincipalSet,
  type PrincipalSet,
} from "../policy-simulate/principal-set";
import { loadConnectionProviders } from "../policy-simulate/connection-providers";
import { loadSecretHosts } from "../policy-simulate/secret-hosts";
import { toSimRule, type SimRule } from "../policy-simulate/sim-rule";
import { buildInjectionProbe } from "./injection";

// The per-tool "effective permissions" reflection behind the App
// Permissions panel (step 9.7b): what the ENFORCED (published) v2 rules decide
// for each catalog tool of a provider, computed with the same engine, inputs,
// and two-level composition the gateway uses. Per tool, every catalog
// path×method variant is synthesized into a concrete request (see
// `synthesizePath`) and run through `evaluatePolicyOutcome`; the variants
// aggregate into one verdict, or `mixed` when they disagree. Read-only — the
// panel's editing moved to the Policy console.
//
// HONESTY NOTES (deliberate, documented):
// - A rule targeting a CONCRETE sub-path narrower than a tool's pattern is not
//   visible to a representative request (it would need pattern-intersection
//   analysis) — the same inherent limit as any per-tool summary.
// - Body conditions cannot be exercised (no body input) — conditioned rules
//   that would match live cannot match here, an inherent limit of any static
//   summary.
// - `hasInjections` is DERIVED per tool host from the agent's credential pools
//   (the injection-probe approximation, hoisted once per request); the response
//   discloses whether a credential is attached so a "Not managed" wall on an
//   unconnected app reads correctly.
//
// REDACTION CONTRACT (this file is its canonical home): org rule
// DETAILS are org-admin-only; a non-admin sees `redacted: true` provenance and
// org rules are excluded from the `variesByIdentity` disclosure count.
//
// RESPONSE CONSTRAINT: tool endpoint mappings (hostPattern/pathPattern/method)
// NEVER serialize — per-tool id + verdict + provenance only (the client-safe
// summary already carries names/descriptions; the leak is pinned by test).

export type EffectiveToolVerdict =
  | "allow"
  | "approval"
  | "block"
  /** Variants (or a group's tools) disagree — shown as "Varies"/"Mixed". */
  | "mixed"
  /** No rule applies and the traffic is unmanaged (no credential, or an LLM
   * host) — the enforce-deny carve passes it through. */
  | "unmanaged";

export type EffectiveProvenance =
  | { kind: "rule"; scope: "organization"; redacted: true }
  | { kind: "rule"; scope: "organization" | "project"; rule: ProvenanceRuleRef }
  /** A level's Default Rule blocked (the deny-default terminal). */
  | { kind: "default"; scope: "organization" | "project" };

export interface EffectiveToolResult {
  toolId: string;
  verdict: EffectiveToolVerdict;
  /** Modifier values of the deciding allow rule (disclosed even when the org
   * rule's NAME is redacted — the simulate contract's accepted disclosure). */
  rateLimit: number | null;
  rateLimitWindow: string | null;
  /** Attribution; null when variants disagree, or when allowed purely by an
   * allow-posture default / unmanaged pass. */
  decidedBy: EffectiveProvenance | null;
}

export interface EffectiveToolGroupResult {
  category: "read" | "write";
  /** The group rollup: the common tool verdict, else "mixed". */
  verdict: EffectiveToolVerdict;
  tools: EffectiveToolResult[];
}

export interface EffectiveAppPermissionsResult {
  provider: string;
  basis: {
    /** null = the agent-less baseline (only any-identity rules match). */
    agentId: string | null;
    /** Whether any of the provider's hosts has a credential attached for this
     * basis (derived — the injection-probe approximation). */
    credentialAttached: boolean;
    scope: "organization" | "project";
  };
  /** Identity-scoped rules relevant to this provider that the BASELINE view
   * cannot show (they only match specific agents/groups) — scoped to the
   * viewer's visibility like `bodyConditionsSkipped`. */
  variesByIdentity: number;
  groups: EffectiveToolGroupResult[];
}

export interface EffectiveAppPermissionsInput {
  provider: string;
  agentId?: string;
}

export interface EffectiveAppPermissionsCtx {
  scope: "organization" | "project";
  organizationId: string;
  /** Required at project scope; absent at org scope. */
  projectId?: string;
  /** Org-admin viewers see org rule details; everyone else gets redaction. */
  viewerSeesOrgRules: boolean;
}

/** The substitution token for `*` slots when synthesizing a concrete request
 * from a catalog pattern. Deliberately collision-proof: no catalog pattern or
 * plausible rule path contains the literal segment `oc-any`, so a synthesized
 * request can only match a rule the way the PATTERN semantics allow — never by
 * a lucky literal collision with a concrete rule path. */
const TOKEN = "oc-any";

/** Synthesize a concrete request path that hits `pattern` under `pathMatches`
 * semantics (which treat the REQUEST path literally): every `*` — a standalone
 * segment, a trailing `/*`, or an intra-segment `prefix*suffix` — is replaced
 * with the token in place. Verified against lib/path-match.ts: a trailing `/*`
 * prefix accepts prefix+token; a mid-path segment glob accepts any single
 * segment; an intra-segment glob accepts the token inline. */
export const synthesizePath = (pattern: string): string => {
  if (pattern === "*") return `/${TOKEN}`;
  return pattern
    .split("/")
    .map((segment) => segment.replaceAll("*", TOKEN))
    .join("/");
};

/** Synthesize a concrete host for a (possibly wildcarded) host pattern —
 * `hostMatches` allows a single leading/trailing `*` with ≥1 substituted char. */
export const synthesizeHost = (pattern: string): string =>
  pattern.replaceAll("*", TOKEN);

/** Load the agent's injection POOL (host patterns + connected-connection
 * providers) — a selective agent's assigned set, or the whole fenced pool for
 * all-mode / the agent-less baseline (a selective agent draws nothing here — its
 * rules are the whole story). The queries run ONCE per request; the predicate is
 * then built via the shared `buildInjectionProbe`, which folds in the rule
 * grants. Org scope probes the org-level pool only. */
const loadInjectionPool = async (
  agent: { id: string; secretMode: string } | null,
  ctx: EffectiveAppPermissionsCtx,
): Promise<{ secretHostPatterns: string[]; providers: string[] }> => {
  // A SELECTIVE agent has no baseline pool since step 10: everything it can be
  // handed comes from its rules, which `buildInjectionProbe` folds in from the
  // injection rule set. (Reading the frozen per-agent grant tables here would
  // both miss every rule-made grant and keep counting revoked ones.)
  if (agent?.secretMode === "selective") {
    return { secretHostPatterns: [], providers: [] };
  }
  const poolWhere =
    ctx.scope === "project"
      ? {
          OR: [
            { projectId: ctx.projectId },
            { organizationId: ctx.organizationId, scope: "organization" },
          ],
        }
      : { organizationId: ctx.organizationId, scope: "organization" };
  const [secrets, connections] = await Promise.all([
    db.secret.findMany({ where: poolWhere, select: { hostPattern: true } }),
    db.appConnection.findMany({
      where: { ...poolWhere, status: "connected" },
      select: { provider: true },
    }),
  ]);
  return {
    secretHostPatterns: secrets.map((s) => s.hostPattern),
    providers: [...new Set(connections.map((c) => c.provider))],
  };
};

interface VariantEval {
  /** Verdict + modifier values folded into one equality key — a rate/approval
   * DIFFERENCE between variants surfaces as `mixed`. Provenance is NOT folded
   * in: two rules producing the SAME verdict must not read as `mixed` (and the
   * verdict must not vary by viewer, since org provenance redacts). */
  key: string;
  verdict: Exclude<EffectiveToolVerdict, "mixed">;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  decidedBy: EffectiveProvenance | null;
}

const provenanceKey = (p: EffectiveProvenance | null): string => {
  if (p === null) return "none";
  if (p.kind === "default") return `default:${p.scope}`;
  if ("redacted" in p) return "rule:org:redacted";
  return `rule:${p.scope}:${p.rule.logicalId}`;
};

const evaluateVariant = (
  simRules: SimRule[],
  engineRules: NewRule[],
  request: PolicyRequest,
  viewerSeesOrgRules: boolean,
): VariantEval => {
  const outcome = evaluatePolicyOutcome(engineRules, request);
  if (outcome.kind === "rule") {
    const sim = simRules.find((s) => s.rule === outcome.rule);
    if (!sim) throw new Error("effective-tools: matched rule lost metadata");
    const decidedBy: EffectiveProvenance =
      sim.meta.scope === "organization" && !viewerSeesOrgRules
        ? { kind: "rule", scope: "organization", redacted: true }
        : {
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
    if (outcome.rule.action === "block") {
      return {
        key: "block",
        verdict: "block",
        rateLimit: null,
        rateLimitWindow: null,
        decidedBy,
      };
    }
    // An approval rule short-circuits before the rate arms at the gateway
    // (evaluate.rs / evaluator.ts `toDecision`), so its stored rate is never
    // enforced — don't disclose it.
    if (outcome.rule.requireApproval) {
      return {
        key: "approval",
        verdict: "approval",
        rateLimit: null,
        rateLimitWindow: null,
        decidedBy,
      };
    }
    const rateLimit = outcome.rule.rateLimit;
    const rateLimitWindow = outcome.rule.rateLimitWindow;
    return {
      key: `allow|${rateLimit ?? ""}|${rateLimitWindow ?? ""}`,
      verdict: "allow",
      rateLimit,
      rateLimitWindow,
      decidedBy,
    };
  }
  if (outcome.kind === "denyDefault") {
    const decidedBy: EffectiveProvenance = {
      kind: "default",
      scope: outcome.level,
    };
    return {
      key: "block",
      verdict: "block",
      rateLimit: null,
      rateLimitWindow: null,
      decidedBy,
    };
  }
  // No rule matched, no default blocked: managed → allowed by the level
  // posture; unmanaged → the enforce-deny carve passes it through untouched.
  const verdict = outcome.managed ? "allow" : "unmanaged";
  return {
    key: verdict === "allow" ? "allow||" : "unmanaged",
    verdict,
    rateLimit: null,
    rateLimitWindow: null,
    decidedBy: null,
  };
};

/** Fold variant evaluations into one per-tool result: identical verdict+modifier
 * keys collapse to that verdict; any disagreement → `mixed`. Attribution is kept
 * only when every variant points at the SAME rule/default — a uniform verdict
 * reached via different rules is truthful but can't name one. */
const aggregateVariants = (
  toolId: string,
  evals: VariantEval[],
): EffectiveToolResult => {
  const first = evals[0];
  if (!first) {
    // A catalog tool always has ≥1 variant; defensive only.
    return {
      toolId,
      verdict: "unmanaged",
      rateLimit: null,
      rateLimitWindow: null,
      decidedBy: null,
    };
  }
  if (evals.every((e) => e.key === first.key)) {
    const sameSource = evals.every(
      (e) => provenanceKey(e.decidedBy) === provenanceKey(first.decidedBy),
    );
    return {
      toolId,
      verdict: first.verdict,
      rateLimit: first.rateLimit,
      rateLimitWindow: first.rateLimitWindow,
      decidedBy: sameSource ? first.decidedBy : null,
    };
  }
  return {
    toolId,
    verdict: "mixed",
    rateLimit: null,
    rateLimitWindow: null,
    decidedBy: null,
  };
};

/** Effective ACCESS to a resource, folded from its per-tool verdicts — the one
 * definition shared by BOTH per-agent surfaces (the credential list and the
 * connection→agents dialog) so they can never disagree. All tools blocked →
 * blocked; all reachable (allow/unmanaged) → usable; anything else (a block, an
 * approval, or a "varies") → limited; no tools → unknown (a catalog-less app). */
export type ToolRollupStatus = "usable" | "limited" | "blocked" | "unknown";

export const rollupToolStatus = (
  verdicts: EffectiveToolVerdict[],
): ToolRollupStatus => {
  if (verdicts.length === 0) return "unknown";
  if (verdicts.every((v) => v === "block")) return "blocked";
  if (verdicts.every((v) => v === "allow" || v === "unmanaged"))
    return "usable";
  return "limited";
};

/** The pure per-request core, shared with the connection reflection (endpoint
 * B computes it once per agent): per catalog tool → per variant → synthesize →
 * evaluate → aggregate, plus the credential-attached signal. */
export const computeEffectiveGroups = (input: {
  def: AppPermissionDefinition;
  simRules: SimRule[];
  engineRules: NewRule[];
  /** "" = the agent-less baseline (never matches an explicit agent identity). */
  agentId: string;
  principals: PrincipalSet;
  probe: (host: string) => boolean;
  viewerSeesOrgRules: boolean;
}): { groups: EffectiveToolGroupResult[]; credentialAttached: boolean } => {
  const baseRequest = {
    agentId: input.agentId,
    userIds: input.principals.userIds,
    groupIds: input.principals.groupIds,
  };
  let credentialAttached = false;
  const groups: EffectiveToolGroupResult[] = input.def.groups.map((group) => {
    // Concrete tools only — the group rollup plays the "All read/write" role;
    // the wildcard is a compact authoring alias, not a distinct endpoint.
    const tools = group.tools.map((tool) => {
      const host = synthesizeHost(tool.hostPattern);
      if (input.probe(host)) credentialAttached = true;
      const evals = allRuleVariants(tool).map((variant) =>
        evaluateVariant(
          input.simRules,
          input.engineRules,
          {
            ...baseRequest,
            host,
            path: synthesizePath(variant.pathPattern),
            // Every catalog tool declares a method (pinned by
            // read-wildcard-coverage.test.ts); GET is a defensive fallback.
            method: variant.method ?? "GET",
            hasInjections: input.probe(host),
            isLlmHost: isLlmHost(host),
          },
          input.viewerSeesOrgRules,
        ),
      );
      return aggregateVariants(tool.id, evals);
    });
    const firstVerdict = tools[0]?.verdict ?? "unmanaged";
    const verdict = tools.every((t) => t.verdict === firstVerdict)
      ? firstVerdict
      : "mixed";
    return { category: group.category, verdict, tools };
  });
  return { groups, credentialAttached };
};

export const effectiveAppPermissions = async (
  input: EffectiveAppPermissionsInput,
  ctx: EffectiveAppPermissionsCtx,
): Promise<EffectiveAppPermissionsResult> => {
  const def = getAppPermissionDefinition(input.provider);
  if (!def) {
    throw new ServiceError(
      "NOT_FOUND",
      `No permission catalog for provider: ${input.provider}`,
    );
  }
  if (ctx.scope === "project" && !ctx.projectId) {
    throw new ServiceError("BAD_REQUEST", "Project scope requires a project.");
  }

  // The agent must belong to the caller's project — a foreign id is simply not
  // found (existence is never revealed across the fence). Baseline when omitted.
  let agent: { id: string; secretMode: string } | null = null;
  if (input.agentId !== undefined) {
    if (ctx.scope !== "project") {
      throw new ServiceError(
        "BAD_REQUEST",
        "Agent-scoped reflection is project-level.",
      );
    }
    agent = await db.agent.findFirst({
      where: { id: input.agentId, projectId: ctx.projectId },
      select: { id: true, secretMode: true },
    });
    if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found.");
  }

  const orgBase = {
    scope: "organization" as const,
    organizationId: ctx.organizationId,
  };
  const projectBase =
    ctx.scope === "project" && ctx.projectId
      ? { scope: "project" as const, projectId: ctx.projectId }
      : null;

  const [
    orgRows,
    projectRows,
    orgInjectRows,
    projectInjectRows,
    principals,
    secretHosts,
    connectionProviders,
    pool,
  ] = await Promise.all([
    loadRulesForSimulation(orgBase, "published"),
    projectBase
      ? loadRulesForSimulation(projectBase, "published")
      : Promise.resolve([]),
    // Injection rules keep `equipment`; the decision rules above drop it.
    loadInjectionRules(orgBase, "published"),
    projectBase
      ? loadInjectionRules(projectBase, "published")
      : Promise.resolve([]),
    // The `agent &&` clause is load-bearing even though the set no longer
    // depends on the agent: the agent-less BASELINE view must not inherit the
    // project's users/groups, or identity-scoped verdicts would leak into it
    // while `variesByIdentity` reports 0.
    agent && ctx.projectId
      ? resolvePrincipalSet(ctx.projectId, ctx.organizationId)
      : Promise.resolve({ userIds: [], groupIds: [] }),
    loadSecretHosts(ctx.organizationId, ctx.projectId ?? ""),
    loadConnectionProviders(ctx.organizationId, ctx.projectId ?? ""),
    loadInjectionPool(agent, ctx),
  ]);

  const allRows = [...orgRows, ...projectRows];
  const injectRows = [...orgInjectRows, ...projectInjectRows];
  const simRules: SimRule[] = allRows.map((row) =>
    toSimRule(row, secretHosts, connectionProviders),
  );
  const engineRules = simRules.map((s) => s.rule);

  // The injectable-credential predicate for the deny-default carve. Fed the
  // INJECTION rules (equipment included, as `inject_select` walks them), not the
  // decision set — otherwise a selective agent's credentials are invisible here
  // and its tools read "unmanaged" when the gateway would call them managed.
  const probe = buildInjectionProbe({
    agent,
    poolSecretHostPatterns: pool.secretHostPatterns,
    poolProviders: pool.providers,
    rules: injectRows,
    principals,
    secretHosts,
    connectionProviders,
  });

  const { groups, credentialAttached } = computeEffectiveGroups({
    def,
    simRules,
    engineRules,
    // The baseline's empty-string agent id can never match an explicit agent
    // identity (ids are never empty) — only any-identity rules apply, exactly
    // "an agent with no specific grants".
    agentId: agent?.id ?? "",
    principals,
    probe,
    viewerSeesOrgRules: ctx.viewerSeesOrgRules,
  });

  // Identity-scoped rules relevant to this provider — what the BASELINE view
  // cannot show. Relevance is decidable cheaply: app targets by provider
  // (connection targets already resolved to app), secret/network targets when
  // their pattern matches a CONCRETE catalog host of the provider (wildcard
  // tool hosts are skipped — undecidable without intersection machinery).
  // Scoped to the viewer's visibility, like bodyConditionsSkipped: org rules
  // are org-rule information.
  const concreteHosts = [
    ...new Set(
      def.groups
        .flatMap((g) => g.tools.map((t) => t.hostPattern))
        .filter((h) => !h.includes("*")),
    ),
  ];
  const disclosable = ctx.viewerSeesOrgRules
    ? simRules
    : simRules.filter((s) => s.meta.scope === "project");
  const variesByIdentity = disclosable.filter((s) => {
    if (s.rule.isDefault || s.rule.identities.length === 0) return false;
    return s.rule.targets.some((t) => {
      if (t.kind === "app") return t.provider === input.provider;
      if (t.kind === "network")
        return concreteHosts.some((h) => hostMatches(h, t.hostPattern));
      if (t.kind === "secret")
        return t.hostPatterns.some((p) =>
          concreteHosts.some((h) => hostMatches(h, p)),
        );
      return false;
    });
  }).length;

  return {
    provider: input.provider,
    basis: {
      agentId: agent?.id ?? null,
      credentialAttached,
      scope: ctx.scope,
    },
    variesByIdentity,
    groups,
  };
};
