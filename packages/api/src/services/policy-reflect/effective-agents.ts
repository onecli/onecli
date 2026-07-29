import { db } from "@onecli/db";
import { ServiceError } from "../../services/errors";
import { getAppPermissionDefinition } from "../../apps/app-permissions";
import {
  loadInjectionRules,
  loadRulesForSimulation,
} from "../policy-simulate/load-rules";
import { resolvePrincipalSet } from "../policy-simulate/principal-set";
import { loadConnectionProviders } from "../policy-simulate/connection-providers";
import { loadSecretHosts } from "../policy-simulate/secret-hosts";
import { toSimRule, type SimRule } from "../policy-simulate/sim-rule";
import {
  computeEffectiveGroups,
  rollupToolStatus,
  type ToolRollupStatus,
} from "./effective-tools";
import { buildInjectionProbe, injectionIdentityMatches } from "./injection";
import type { CredentialProvenance } from "./effective-credentials";

// The per-agent reflection behind the connection "agent access" dialog
// (step 9.7b): for every agent in the caller's project, TWO axes —
//
// 1. CREDENTIAL (primary — the old dialog's full/assigned/none meaning): would
//    this connection inject for the agent, under the same laws as the
//    effective-credentials reflection (inject_select.rs): an ALL-mode agent
//    draws the whole pool ("full"); a SELECTIVE agent is attached iff ASSIGNED
//    (an AgentAppConnection row — injection-live via the bridge) or GRANTED by
//    a published, enabled allow rule with an EXPLICIT matching identity whose
//    target names this connection (`connection.appConnectionId`) or its
//    provider pool (`app` + `connectionScope` matching the connection's level).
//    Empty identities never inject.
// 2. DECISIONS (secondary): the per-tool rollup of the provider's catalog under
//    the same engine as the effective-app-permissions reflection —
//    `{allowedTools, totalTools, anyApproval, anyRateLimit}` where "allowed"
//    counts allow/approval/unmanaged verdicts (reachable), and blocked/mixed
//    don't. A catalog-less provider has NO rollup (`decisions: null`) — policy
//    rules can't target its endpoints, so "0 of 0" would be a lie.
//
// Fencing: the connection must be project-owned or org-scoped in the caller's
// org; agents are the caller's project's. Perf: the rule set, pools, and the
// principal set load ONCE — the principal set is project-derived, so every
// agent in the project shares it.
//
// REDACTION: org rule provenance follows the simulate contract (names are
// org-admin-only; multiple org refs collapse to one redacted marker).

export type AgentCredentialStatus =
  | { status: "full" }
  | { status: "viaRule"; provenance: CredentialProvenance[] }
  | { status: "none" };

/** The EFFECTIVE access headline (the user decision — lead with what the agent
 * can DO, not whether a credential is attached): can it actually use this
 * connection under the rules? */
export type AgentAccessStatus =
  /** Attached and every tool reachable. */
  | "usable"
  /** Attached, some tools blocked or need approval. */
  | "limited"
  /** Attached but every tool blocked by a rule. */
  | "blocked"
  /** No credential attached — can't use the connection at all. */
  | "none"
  /** Attached, but a custom app with no catalog to evaluate. */
  | "unknown";

export interface EffectiveAgentEntry {
  agentId: string;
  name: string;
  /** The headline: effective access under the rules. */
  access: AgentAccessStatus;
  /** How the credential is (or isn't) attached — the secondary detail. */
  credential: AgentCredentialStatus;
  decisions: {
    allowedTools: number;
    totalTools: number;
    anyApproval: boolean;
    anyRateLimit: boolean;
  } | null;
}

export interface EffectiveAgentsResult {
  connectionId: string;
  provider: string;
  /** false = no permission catalog — the decisions axis is absent by honesty. */
  catalog: boolean;
  agents: EffectiveAgentEntry[];
}

export interface EffectiveAgentsCtx {
  projectId: string;
  organizationId: string;
  viewerSeesOrgRules: boolean;
}

interface RuleRef {
  scope: "organization" | "project";
  logicalId: string;
  name: string;
}

/** Collapse rule refs into provenance, org refs redacted for non-admins (one
 * marker regardless of count — the effective-credentials contract). */
const toProvenance = (
  refs: RuleRef[],
  viewerSeesOrgRules: boolean,
): CredentialProvenance[] => {
  const out: CredentialProvenance[] = [];
  const seen = new Set<string>();
  let redactedEmitted = false;
  for (const ref of refs) {
    if (ref.scope === "organization" && !viewerSeesOrgRules) {
      if (!redactedEmitted) {
        out.push({ kind: "rule", scope: "organization", redacted: true });
        redactedEmitted = true;
      }
      continue;
    }
    if (seen.has(ref.logicalId)) continue;
    seen.add(ref.logicalId);
    out.push({
      kind: "rule",
      scope: ref.scope,
      rule: { logicalId: ref.logicalId, name: ref.name },
    });
  }
  return out;
};

export const effectiveAgents = async (
  connectionId: string,
  ctx: EffectiveAgentsCtx,
): Promise<EffectiveAgentsResult> => {
  // Fence — project-owned OR org-scoped in the caller's org; a foreign
  // connection is simply not found (existence is never revealed across it).
  const project = await db.project.findUnique({
    where: { id: ctx.projectId },
    select: { organizationId: true },
  });
  const connection = await db.appConnection.findFirst({
    where: {
      id: connectionId,
      OR: [
        { projectId: ctx.projectId },
        ...(project?.organizationId
          ? [{ organizationId: project.organizationId, scope: "organization" }]
          : []),
      ],
    },
    select: { id: true, provider: true, scope: true },
  });
  if (!connection) throw new ServiceError("NOT_FOUND", "Connection not found");

  const connectionLevel: "organization" | "project" =
    connection.scope === "organization" ? "organization" : "project";
  const def = getAppPermissionDefinition(connection.provider);

  const agents = await db.agent.findMany({
    where: { projectId: ctx.projectId },
    select: { id: true, name: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });

  const [
    orgRows,
    projectRows,
    orgInjectRows,
    projectInjectRows,
    secretHosts,
    connectionProviders,
    principals,
  ] = await Promise.all([
    loadRulesForSimulation(
      { scope: "organization", organizationId: ctx.organizationId },
      "published",
    ),
    loadRulesForSimulation(
      { scope: "project", projectId: ctx.projectId },
      "published",
    ),
    // Injection rules keep `equipment` (the decision rules above drop it) —
    // they are what an agent's access is actually made of (step 7: every
    // agent is rule-selected; there is no all-mode pool arm left).
    loadInjectionRules(
      { scope: "organization", organizationId: ctx.organizationId },
      "published",
    ),
    loadInjectionRules(
      { scope: "project", projectId: ctx.projectId },
      "published",
    ),
    loadSecretHosts(ctx.organizationId, ctx.projectId),
    loadConnectionProviders(ctx.organizationId, ctx.projectId),
    resolvePrincipalSet(ctx.projectId, ctx.organizationId),
  ]);

  const allRows = [...orgRows, ...projectRows];
  const injectRows = [...orgInjectRows, ...projectInjectRows];
  const simRules: SimRule[] = allRows.map((row) =>
    toSimRule(row, secretHosts, connectionProviders),
  );
  const engineRules = simRules.map((s) => s.rule);
  const totalTools = def
    ? def.groups.reduce((n, g) => n + g.tools.length, 0)
    : 0;

  // The injection-relevant allow rules, prefiltered to THIS connection: a
  // connection target naming it, or an app+connectionScope pool grant covering
  // its provider at its level.
  const grantingRules = injectRows
    .filter((row) => !row.isDefault && row.action === "allow")
    .map((row) => ({
      row,
      grants: row.targets.some(
        (t) =>
          (t.kind === "connection" && t.appConnectionId === connectionId) ||
          (t.kind === "app" &&
            t.appProvider === connection.provider &&
            t.appConnectionScope === connectionLevel),
      ),
    }))
    .filter((r) => r.grants)
    .map(({ row }) => row);

  const entries: EffectiveAgentEntry[] = agents.map((agent) => {
    // Every attachment is a rule (step 7: there is no all-mode "full pool"
    // status left) — the old per-agent grants became `equipment` rules, which
    // the injection load carries. There is no separate "assigned" source left
    // to distinguish.
    const refs: RuleRef[] = grantingRules
      .filter((row) =>
        injectionIdentityMatches(row.identities, agent.id, principals),
      )
      .map((row) => ({
        scope: row.scope === "organization" ? "organization" : "project",
        logicalId: row.logicalId,
        name: row.name,
      }));
    const credential: AgentCredentialStatus =
      refs.length > 0
        ? {
            status: "viaRule",
            provenance: toProvenance(refs, ctx.viewerSeesOrgRules),
          }
        : { status: "none" };

    let decisions: EffectiveAgentEntry["decisions"] = null;
    let toolStatus: ToolRollupStatus = "unknown";
    if (def) {
      // The deny-default carve's injectable predicate. An agent draws NOTHING
      // from the pool — its rules are the whole story (the injection set below
      // carries them) — matching the credential axis so the decisions rollup
      // can't contradict "Attached · via rule".
      const probe = buildInjectionProbe({
        agent,
        poolSecretHostPatterns: [],
        poolProviders: [],
        rules: injectRows,
        principals,
        secretHosts,
        connectionProviders,
      });
      const { groups } = computeEffectiveGroups({
        def,
        simRules,
        engineRules,
        agentId: agent.id,
        principals,
        probe,
        viewerSeesOrgRules: ctx.viewerSeesOrgRules,
        // This endpoint is scoped to ONE connection — reflect it as the
        // winner, so per-account rules bind exactly as the gateway would and
        // the N-of-M decisions are per-connection-accurate.
        winningConnectionId: connectionId,
      });
      const tools = groups.flatMap((g) => g.tools);
      // The rollup status matches the credential dialog EXACTLY (the shared
      // `rollupToolStatus`) so the two surfaces can't disagree — all-approval
      // reads "limited" on both, not "usable" on one.
      toolStatus = rollupToolStatus(tools.map((t) => t.verdict));
      decisions = {
        allowedTools: tools.filter(
          (t) =>
            t.verdict === "allow" ||
            t.verdict === "approval" ||
            t.verdict === "unmanaged",
        ).length,
        totalTools,
        anyApproval: tools.some((t) => t.verdict === "approval"),
        anyRateLimit: tools.some((t) => t.rateLimit !== null),
      };
    }

    // The effective-access headline: no credential → can't use it; else the
    // shared per-tool rollup (a custom app with no catalog stays "unknown").
    const access: AgentAccessStatus =
      credential.status === "none" ? "none" : def ? toolStatus : "unknown";

    return {
      agentId: agent.id,
      name: agent.name,
      access,
      credential,
      decisions,
    };
  });

  return {
    connectionId: connection.id,
    provider: connection.provider,
    catalog: !!def,
    agents: entries,
  };
};
