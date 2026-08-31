import { db } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import {
  getAppPermissionDefinition,
  hostPatternsOf,
  type AppPermissionDefinition,
  type AppTool,
} from "../../apps/app-permissions";
import { hostMatches, isLlmHost } from "../../lib/path-match";
import { allRuleVariants } from "../policy-translation/translate/app-catalog";
import { evaluatePolicyOutcome } from "../policy-translation/evaluator";
import type { NewRule, PolicyRequest } from "../policy-translation/types";
import type { ProvenanceRuleRef } from "../policy-simulate/sim-rule";
import {
  loadInjectionRules,
  loadRulesForSimulation,
  type SimRuleRow,
} from "../policy-simulate/load-rules";
import type { SessionPolicyInput } from "../../validations/policy";
import { intersectPolicies } from "../../lib/resource-axis";
import {
  orgResourceBoundary,
  workspaceResourceSelection,
} from "./org-resource-boundary";
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
// - A `graphqlOps`-tagged tool's variants synthesize a REPRESENTATIVE body of
//   the tool's own kind (a minimal pure query / a minimal mutation), so the
//   fail-closed classifier resolves the same way it will live and the panel's
//   verdict matches the gateway. (Without a body, every GraphQL-tagged query
//   tool would fail-close to "mutation" and misreport as blocked.)
// - `hasInjections` is DERIVED per tool host from the agent's credential pools
//   (the injection-probe approximation, hoisted once per request); the response
//   discloses whether a credential is attached so a "Not managed" wall on an
//   unconnected app reads correctly.
//
// REDACTION CONTRACT (this file is its canonical home): org rule
// DETAILS are org-admin-only; a non-admin sees `redacted: true` provenance and
// org rules are excluded from the `variesByIdentity` disclosure count.
// `orgResources` deliberately discloses the org rule's repo/folder VALUES —
// never the rule's name or identity — to workspace viewers: the same posture as
// the rate-limit values above, and for GitHub the repo list is already visible
// via the connection's own metadata.
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
  | {
      kind: "rule";
      scope: "organization" | "workspace";
      rule: ProvenanceRuleRef;
    }
  /** A level's Default Rule blocked (the deny-default terminal). */
  | { kind: "default"; scope: "organization" | "workspace" };

/** What the ORG level alone says about a tool — the ceiling the workspace may
 * tighten under but never loosen past. Derived from an org-rules-only engine
 * run, so it stays visible even when a stricter workspace rule wins the combined
 * verdict. Carries no rule ref (members may learn THAT the org constrains,
 * never which rule — the §2.9 redaction posture). `null` = the org is silent
 * (no matching rule, allow posture, or the enforce-deny carve passed it). */
export type OrgCeilingVerdict = "allow" | "approval" | "block";

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
  orgCeiling: OrgCeilingVerdict | null;
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
    scope: "organization" | "workspace";
  };
  /** Identity-scoped rules relevant to this provider that the BASELINE view
   * cannot show (they only match specific agents/groups) — scoped to the
   * viewer's visibility like `bodyConditionsSkipped`. */
  variesByIdentity: number;
  /** The ORG's resource boundary ("Resources") for this (agent, connection) —
   * how far the organization allows the credential to reach, which a workspace
   * selection narrows within but can never exceed. Only computed for an
   * explicit `agentId` + `connectionId`; null = the org does not restrict (or
   * no explicit basis). Discloses values only — see the redaction contract. */
  orgResources: SessionPolicyInput | null;
  /** What the credential actually reaches: the org boundary composed with the
   * workspace's selection. An empty list means the two do not overlap and the
   * credential reaches nothing (the gateway refuses every request). */
  effectiveResources: SessionPolicyInput | null;
  groups: EffectiveToolGroupResult[];
}

export interface EffectiveAppPermissionsInput {
  provider: string;
  agentId?: string;
  /** Reflect for ONE specific connection: synthesized requests carry it as the
   * winning injected connection, so per-account rules bind exactly as the
   * gateway would. Absent = the provider-level view (per-account differences
   * fold to `mixed`). Workspace scope only, like `agentId`. */
  connectionId?: string;
}

export interface EffectiveAppPermissionsCtx {
  scope: "organization" | "workspace";
  organizationId: string;
  /** Required at workspace scope; absent at org scope. */
  workspaceId?: string;
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

/** Synthesize the representative request body for a tool: GraphQL-tagged
 * tools get a minimal document of their own kind (so the fail-closed
 * classifier resolves exactly as it will live - see the honesty note above);
 * everything else stays body-less. The documents are the smallest valid
 * members of each class under both ports' classifiers. */
export const synthesizeBody = (tool: AppTool): string | undefined => {
  if (tool.graphqlOps === "query")
    return JSON.stringify({ query: `query { ${TOKEN} }` });
  if (tool.graphqlOps === "mutation")
    return JSON.stringify({ query: `mutation { ${TOKEN} }` });
  return undefined;
};

/** Load the injection POOL (host patterns + connected-connection providers) —
 * the whole fenced pool for the agent-less BASELINE only. An agent draws
 * nothing here (step 7: its rules are the whole story, folded in by the shared
 * `buildInjectionProbe`). The queries run ONCE per request. Org scope probes
 * the org-level pool only. */
const loadInjectionPool = async (
  agent: { id: string } | null,
  ctx: EffectiveAppPermissionsCtx,
): Promise<{ secretHostPatterns: string[]; providers: string[] }> => {
  // An agent has no baseline pool: everything it can be handed comes from its
  // rules, which `buildInjectionProbe` folds in from the injection rule set.
  // (Reading the frozen per-agent grant tables here would both miss every
  // rule-made grant and keep counting revoked ones.)
  if (agent !== null) {
    return { secretHostPatterns: [], providers: [] };
  }
  const poolWhere =
    ctx.scope === "workspace"
      ? {
          OR: [
            { workspaceId: ctx.workspaceId },
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
  orgCeiling: OrgCeilingVerdict | null;
}

/** Strictest-wins fold for ceilings (block > approval > allow > silent):
 * variants or per-account runs that disagree lock at the tightest answer —
 * over-locking a path-split tool is safe, under-locking invites the
 * "clicked one thing, got another" save. Mirrors the engine's
 * strictest-combine direction. */
const CEILING_RANK: Record<OrgCeilingVerdict, number> = {
  allow: 1,
  approval: 2,
  block: 3,
};

const foldCeilings = (
  ceilings: (OrgCeilingVerdict | null)[],
): OrgCeilingVerdict | null =>
  ceilings.reduce<OrgCeilingVerdict | null>(
    (a, b) =>
      b === null ? a : a === null || CEILING_RANK[b] > CEILING_RANK[a] ? b : a,
    null,
  );

/** The org level evaluated ALONE — the same request, org rules only, so org
 * per-connection targets and the enforce-deny carve bind exactly as live. The
 * corpus-gated engine core is reused unchanged; only the input set narrows. */
const orgCeilingOf = (
  engineRules: NewRule[],
  request: PolicyRequest,
): OrgCeilingVerdict | null => {
  const outcome = evaluatePolicyOutcome(
    engineRules.filter((r) => r.scope === "organization"),
    request,
  );
  if (outcome.kind === "rule") {
    if (outcome.rule.action === "block") return "block";
    return outcome.rule.requireApproval ? "approval" : "allow";
  }
  if (outcome.kind === "denyDefault") return "block";
  // Managed allow-posture pass or the unmanaged carve: the org imposes nothing.
  return null;
};

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
  const orgCeiling = orgCeilingOf(engineRules, request);
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
        orgCeiling,
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
        orgCeiling,
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
      orgCeiling,
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
      orgCeiling,
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
    orgCeiling,
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
      orgCeiling: null,
    };
  }
  // The ceiling folds independently of the combined-verdict key: a ceiling
  // difference between path variants must not read as `mixed`, and a `mixed`
  // combined verdict can still carry a definite (strictest) ceiling lock.
  const orgCeiling = foldCeilings(evals.map((e) => e.orgCeiling));
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
      orgCeiling,
    };
  }
  return {
    toolId,
    verdict: "mixed",
    rateLimit: null,
    rateLimitWindow: null,
    decidedBy: null,
    orgCeiling,
  };
};

/** Fold the per-account runs of a provider-level view into one: tools that
 * agree across every connected account keep their verdict (and provenance when
 * uniform); any disagreement is `mixed` — the truthful provider-level answer
 * once decisions bind per-connection. */
const foldGroupRuns = (
  runs: EffectiveToolGroupResult[][],
): EffectiveToolGroupResult[] => {
  const first = runs[0];
  if (!first || runs.length === 1) return first ?? [];
  const toolKey = (t: EffectiveToolResult) =>
    `${t.verdict}|${t.rateLimit ?? ""}|${t.rateLimitWindow ?? ""}`;
  return first.map((group, gi) => {
    const tools = group.tools.map((tool, ti) => {
      const across = runs.map((r) => r[gi]?.tools[ti] ?? tool);
      // Same independence as the variant fold: per-account ceiling
      // disagreement locks at the strictest, never flips the verdict.
      const orgCeiling = foldCeilings(across.map((t) => t.orgCeiling));
      if (across.every((t) => toolKey(t) === toolKey(tool))) {
        const sameSource = across.every(
          (t) => provenanceKey(t.decidedBy) === provenanceKey(tool.decidedBy),
        );
        return sameSource
          ? { ...tool, orgCeiling }
          : { ...tool, decidedBy: null, orgCeiling };
      }
      return {
        toolId: tool.toolId,
        verdict: "mixed" as const,
        rateLimit: null,
        rateLimitWindow: null,
        decidedBy: null,
        orgCeiling,
      };
    });
    const firstVerdict = tools[0]?.verdict ?? "unmanaged";
    const verdict = tools.every((t) => t.verdict === firstVerdict)
      ? firstVerdict
      : ("mixed" as const);
    return { category: group.category, verdict, tools };
  });
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
  /** The winning injected connection the synthesized requests carry — absent =
   * no winner, so resolved connection targets never match (the gateway law). */
  winningConnectionId?: string;
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
      const body = synthesizeBody(tool);
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
            body,
            hasInjections: input.probe(host),
            isLlmHost: isLlmHost(host),
            winningConnectionId: input.winningConnectionId,
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
  if (ctx.scope === "workspace" && !ctx.workspaceId) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Workspace scope requires a workspace.",
    );
  }

  // The agent must belong to the caller's workspace — a foreign id is simply not
  // found (existence is never revealed across the fence). Baseline when omitted.
  let agent: { id: string } | null = null;
  if (input.agentId !== undefined) {
    if (ctx.scope !== "workspace") {
      throw new ServiceError(
        "BAD_REQUEST",
        "Agent-scoped reflection is workspace-level.",
      );
    }
    agent = await db.agent.findFirst({
      where: { id: input.agentId, workspaceId: ctx.workspaceId },
      select: { id: true },
    });
    if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found.");
  }

  // Same fence for an explicit connection: it must be THIS provider's and
  // visible to the caller's scope (workspace-owned or org-shared) — a foreign id
  // is simply not found (existence is never revealed across the fence).
  let connection: { id: string } | null = null;
  if (input.connectionId !== undefined) {
    if (ctx.scope !== "workspace") {
      throw new ServiceError(
        "BAD_REQUEST",
        "Connection-scoped reflection is workspace-level.",
      );
    }
    connection = await db.appConnection.findFirst({
      where: {
        id: input.connectionId,
        provider: input.provider,
        OR: [
          { workspaceId: ctx.workspaceId },
          { organizationId: ctx.organizationId, scope: "organization" },
        ],
      },
      select: { id: true },
    });
    if (!connection) {
      throw new ServiceError("NOT_FOUND", "Connection not found.");
    }
  }

  const orgBase = {
    scope: "organization" as const,
    organizationId: ctx.organizationId,
  };
  const workspaceBase =
    ctx.scope === "workspace" && ctx.workspaceId
      ? { scope: "workspace" as const, workspaceId: ctx.workspaceId }
      : null;

  const [
    orgRows,
    workspaceRows,
    orgInjectRows,
    workspaceInjectRows,
    principals,
    secretHosts,
    connectionProviders,
    pool,
  ] = await Promise.all([
    loadRulesForSimulation(orgBase, "published"),
    workspaceBase
      ? loadRulesForSimulation(workspaceBase, "published")
      : Promise.resolve([]),
    // Injection rules keep `equipment`; the decision rules above drop it.
    loadInjectionRules(orgBase, "published"),
    workspaceBase
      ? loadInjectionRules(workspaceBase, "published")
      : Promise.resolve([]),
    // The `agent &&` clause is load-bearing even though the set no longer
    // depends on the agent: the agent-less BASELINE view must not inherit the
    // workspace's users/groups, or identity-scoped verdicts would leak into it
    // while `variesByIdentity` reports 0.
    agent && ctx.workspaceId
      ? resolvePrincipalSet(ctx.workspaceId, ctx.organizationId)
      : Promise.resolve({ userIds: [], groupIds: [] }),
    loadSecretHosts(ctx.organizationId, ctx.workspaceId ?? ""),
    loadConnectionProviders(ctx.organizationId, ctx.workspaceId ?? ""),
    loadInjectionPool(agent, ctx),
  ]);

  const allRows = [...orgRows, ...workspaceRows];
  const injectRows = [...orgInjectRows, ...workspaceInjectRows];
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

  const runCompute = (winningConnectionId?: string) =>
    computeEffectiveGroups({
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
      winningConnectionId,
    });

  // Per-connection accuracy. An explicit connection reflects with it as the
  // winner. The provider-level view may VARY by account once resolved
  // connection targets name this provider — evaluate once per connected
  // account and fold disagreements to `mixed`; with no connection rules the
  // single no-winner pass is byte-identical to the pre-per-connection view.
  const hasConnectionRules = engineRules.some((r) =>
    r.targets.some(
      (t) => t.kind === "connection" && t.provider === input.provider,
    ),
  );
  const providerConnectionIds = [...connectionProviders.entries()]
    .filter(([, p]) => p === input.provider)
    .map(([id]) => id);
  let folded: {
    groups: EffectiveToolGroupResult[];
    credentialAttached: boolean;
  };
  if (connection) {
    folded = runCompute(connection.id);
  } else if (hasConnectionRules && providerConnectionIds.length > 0) {
    const runs = providerConnectionIds.map((id) => runCompute(id));
    folded = {
      groups: foldGroupRuns(runs.map((r) => r.groups)),
      credentialAttached: runs.some((r) => r.credentialAttached),
    };
  } else {
    folded = runCompute();
  }
  const { groups, credentialAttached } = folded;

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
        .flatMap((g) => g.tools.flatMap((t) => hostPatternsOf(t)))
        .filter((h) => !h.includes("*")),
    ),
  ];
  const disclosable = ctx.viewerSeesOrgRules
    ? simRules
    : simRules.filter((s) => s.meta.scope === "workspace");
  const variesByIdentity = disclosable.filter((s) => {
    if (s.rule.isDefault || s.rule.identities.length === 0) return false;
    return s.rule.targets.some((t) => {
      if (t.kind === "app") return t.provider === input.provider;
      // A RESOLVED connection target carries its provider; unresolved
      // (provider-less) ones never match anything, so they can't vary either.
      if (t.kind === "connection") return t.provider === input.provider;
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
    ...resourceScopes(
      agent && connection
        ? {
            orgInjectRows,
            workspaceInjectRows,
            agentId: agent.id,
            principals,
            connectionId: connection.id,
          }
        : null,
    ),
    groups,
  };
};

/** The org boundary and the effective (composed) scope for the basis, or nulls
 * when the reflection has no explicit (agent, connection) to reason about. */
const resourceScopes = (
  basis: {
    orgInjectRows: SimRuleRow[];
    workspaceInjectRows: SimRuleRow[];
    agentId: string;
    principals: PrincipalSet;
    connectionId: string;
  } | null,
): {
  orgResources: SessionPolicyInput | null;
  effectiveResources: SessionPolicyInput | null;
} => {
  if (!basis) return { orgResources: null, effectiveResources: null };
  const orgResources = orgResourceBoundary(
    basis.orgInjectRows,
    basis.agentId,
    basis.principals,
    basis.connectionId,
  );
  const workspaceResources = workspaceResourceSelection(
    basis.workspaceInjectRows,
    basis.agentId,
    basis.principals,
    basis.connectionId,
  );
  return {
    orgResources,
    effectiveResources: intersectPolicies(orgResources, workspaceResources),
  };
};
