import { db } from "@onecli/db";
import { listAgents } from "./agent-service";
import { injectionIdentityMatches } from "./policy-reflect/injection";
import { loadInjectionRules } from "./policy-simulate/load-rules";
import { resolvePrincipalSet } from "./policy-simulate/principal-set";

/**
 * The agents-list chips feed (`GET /v1/agents?include=grants-summary`): per
 * agent, the distinct credentials that would INJECT for it — the attach list,
 * not effective verdicts (Usable/Limited/Blocked stays a per-agent-page
 * reflection; chips must be cheap for a whole list).
 *
 * Derived from the INJECTION LAW across every rule source — inject_select's
 * predicate: published, enabled, non-default allow rules whose identity
 * explicitly names the agent (own id, or an inherited user/group principal) —
 * NOT from `source:"grant"` alone: until the step-5 migration, agents' access
 * lives in `equipment`/`custom` rows and the all-mode pool, and a
 * source-filtered summary would blank every pre-existing agent's chips.
 *
 * Constant query count regardless of agent count: one agent list, one
 * principal-set resolution (agent-independent by design), two injection-rule
 * loads (org + project, equipment kept), then batched fenced resolutions over
 * the cross-agent unions. Zero engine evaluations.
 */

export type GrantsSummaryEntry =
  | {
      kind: "app";
      provider: string;
      connectionId: string;
      label: string | null;
    }
  | { kind: "secret" | "llm"; id: string; name: string };

export interface AgentGrantsSummary {
  /** Always `"grants"` since step 7 (the gateway is grants-only); the `"all"`
   * arm stays for wire compat and narrows away with the column in step 8. */
  mode: "all" | "grants";
  entries: GrantsSummaryEntry[];
  total: number;
}

export interface AgentWithGrantsSummary {
  id: string;
  name: string;
  identifier: string;
  accessToken: string;
  isDefault: boolean;
  secretMode: string;
  createdAt: Date;
  grantsSummary: AgentGrantsSummary;
}

/** The LLM/plain-secret split, mirroring counts-service. */
const secretKind = (type: string): "secret" | "llm" =>
  type === "generic" ? "secret" : "llm";

export const listAgentsWithGrantsSummary = async (
  projectId: string,
  organizationId: string,
): Promise<AgentWithGrantsSummary[]> => {
  const orgBase = { scope: "organization" as const, organizationId };
  const projectBase = { scope: "project" as const, projectId };
  const [agents, principals, orgRows, projectRows] = await Promise.all([
    listAgents(projectId),
    resolvePrincipalSet(projectId, organizationId),
    loadInjectionRules(orgBase, "published"),
    loadInjectionRules(projectBase, "published"),
  ]);
  const injectRows = [...orgRows, ...projectRows];

  const secretPool = {
    OR: [{ projectId }, { organizationId, scope: "organization" }],
  };
  const connectionPool = { ...secretPool, status: "connected" };

  // Per agent, walk the injection-law rules once, collecting the four target
  // arms (mirrors effective-credentials' selective walk).
  interface Collected {
    secretIds: Set<string>;
    connectionIds: Set<string>;
    secretLevels: Set<"organization" | "project">;
    /** `${provider}\n${level}` pairs — the level picks org- vs project-scoped
     * connections of the provider (inject_select's app_scopes law). */
    providerLevels: Set<string>;
  }
  const perAgent = new Map<string, Collected>();
  let anyScopeGrant = false;
  for (const agent of agents) {
    const collected: Collected = {
      secretIds: new Set(),
      connectionIds: new Set(),
      secretLevels: new Set(),
      providerLevels: new Set(),
    };
    for (const row of injectRows) {
      if (row.isDefault || row.action !== "allow") continue;
      if (!injectionIdentityMatches(row.identities, agent.id, principals))
        continue;
      for (const t of row.targets) {
        if (t.kind === "secret") {
          if (t.secretId) collected.secretIds.add(t.secretId);
          else if (
            t.secretScope === "organization" ||
            t.secretScope === "project"
          )
            collected.secretLevels.add(t.secretScope);
        } else if (t.kind === "connection" && t.appConnectionId) {
          collected.connectionIds.add(t.appConnectionId);
        } else if (
          t.kind === "app" &&
          t.appProvider &&
          (t.appConnectionScope === "organization" ||
            t.appConnectionScope === "project")
        ) {
          collected.providerLevels.add(
            `${t.appProvider}\n${t.appConnectionScope}`,
          );
        }
      }
    }
    if (collected.secretLevels.size > 0 || collected.providerLevels.size > 0) {
      anyScopeGrant = true;
    }
    perAgent.set(agent.id, collected);
  }

  // Batched fenced resolution over the cross-agent unions. A whole-pool load
  // serves every all-mode agent and every level/provider-scope expansion at
  // once; otherwise only the union of rule-named ids is fetched.
  const namedSecretIds = new Set(
    [...perAgent.values()].flatMap((c) => [...c.secretIds]),
  );
  const namedConnectionIds = new Set(
    [...perAgent.values()].flatMap((c) => [...c.connectionIds]),
  );
  const loadWholePools = anyScopeGrant;
  const [secrets, connections] = await Promise.all([
    loadWholePools || namedSecretIds.size > 0
      ? db.secret.findMany({
          where: loadWholePools
            ? secretPool
            : { id: { in: [...namedSecretIds] }, ...secretPool },
          select: {
            id: true,
            name: true,
            type: true,
            scope: true,
            projectId: true,
          },
        })
      : Promise.resolve([]),
    loadWholePools || namedConnectionIds.size > 0
      ? db.appConnection.findMany({
          where: loadWholePools
            ? connectionPool
            : { id: { in: [...namedConnectionIds] }, ...connectionPool },
          select: {
            id: true,
            provider: true,
            label: true,
            scope: true,
            projectId: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const secretById = new Map(secrets.map((s) => [s.id, s]));
  const connectionById = new Map(connections.map((c) => [c.id, c]));

  const levelOf = (row: {
    scope: string;
    projectId: string | null;
  }): "organization" | "project" =>
    row.scope === "organization" ? "organization" : "project";

  return agents.map((agent) => {
    // Every agent was walked above (step 7: there is no all-mode whole-pool
    // arm left) — a missing entry can only mean an empty collection.
    const collected = perAgent.get(agent.id);
    const entries: GrantsSummaryEntry[] = [];
    if (collected) {
      const connectionIds = new Set(collected.connectionIds);
      for (const c of connections) {
        if (collected.providerLevels.has(`${c.provider}\n${levelOf(c)}`)) {
          connectionIds.add(c.id);
        }
      }
      for (const id of connectionIds) {
        const c = connectionById.get(id);
        if (!c) continue; // deleted/foreign — the fence dropped it
        entries.push({
          kind: "app",
          provider: c.provider,
          connectionId: c.id,
          label: c.label,
        });
      }
      const secretIds = new Set(collected.secretIds);
      for (const s of secrets) {
        if (collected.secretLevels.has(levelOf(s))) secretIds.add(s.id);
      }
      for (const id of secretIds) {
        const s = secretById.get(id);
        if (!s) continue;
        entries.push({ kind: secretKind(s.type), id: s.id, name: s.name });
      }
    }
    return {
      ...agent,
      grantsSummary: {
        // Constant since step 7 — see the type's doc.
        mode: "grants" as const,
        entries,
        total: entries.length,
      },
    };
  });
};
