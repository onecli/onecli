import { db } from "@onecli/db";
import {
  MAX_AGENT_CONNECTION_LABEL_CHARS,
  MAX_AGENT_CONNECTION_NAME_CHARS,
  MAX_AGENT_CONNECTIONS,
  cleanLabel,
  type AgentConnectionWire,
} from "@onecli/agent-protocol";
import { getApp } from "../apps/registry";
import { extractBoundHost } from "../lib/connection-display";
import {
  grantedConnectionSelection,
  providerLevelKey,
} from "./policy-reflect/injection";
import { loadInjectionRules } from "./policy-simulate/load-rules";
import { resolvePrincipalSet } from "./policy-simulate/principal-set";

/**
 * The app connections attached to ONE agent, as the supervisor's
 * `connections` capability receives them: which services the gateway holds
 * a credential for, and, for host-bound apps (a Salesforce org's My Domain, a
 * Snowflake account host, a JFrog instance), the one host that credential is
 * bound to (`metadata.bound_host`).
 *
 * Why this exists: an agent that did not know an org's host guessed
 * `login.salesforce.com` (and another, `api.snowflake.com`), the gateway
 * correctly injected nothing there, and the agent told the user the app was
 * not connected — while it was. The host cannot be guessed; it has to be
 * stated. Composed at dispatch and on every home sync, the `peersForRender`
 * pattern.
 *
 * The attach set is `grantedConnectionSelection`, the same law the grants
 * summary and the gateway's `inject_select` read: published, enabled,
 * non-default allow rules whose identity names the agent, expanded over named
 * connections and provider-level grants through the org/workspace-fenced
 * pool. Only catalog apps are listed, and only non-secret metadata is read.
 */
export const connectionsForRender = async (
  agentId: string,
): Promise<AgentConnectionWire[]> => {
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: {
      workspaceId: true,
      workspace: { select: { organizationId: true } },
    },
  });
  if (!agent) return [];
  const workspaceId = agent.workspaceId;
  const organizationId = agent.workspace.organizationId;

  const [principals, orgRows, workspaceRows] = await Promise.all([
    resolvePrincipalSet(workspaceId, organizationId),
    loadInjectionRules({ scope: "organization", organizationId }, "published"),
    loadInjectionRules({ scope: "workspace", workspaceId }, "published"),
  ]);
  const { ids, providerLevels } = grantedConnectionSelection(
    [...orgRows, ...workspaceRows],
    agentId,
    principals,
  );
  if (ids.size === 0 && providerLevels.size === 0) return [];

  // Fenced on the fetch: a rule naming a foreign id, or a provider-level
  // grant, can only ever reach this org's and this workspace's pool.
  const pool = {
    status: "connected",
    OR: [{ workspaceId }, { organizationId, scope: "organization" }],
  };
  const rows = await db.appConnection.findMany({
    where: providerLevels.size > 0 ? pool : { ...pool, id: { in: [...ids] } },
    select: {
      id: true,
      provider: true,
      label: true,
      scope: true,
      metadata: true,
    },
    orderBy: [{ provider: "asc" }, { connectedAt: "asc" }],
  });

  const out: AgentConnectionWire[] = [];
  for (const row of rows) {
    const level = row.scope === "organization" ? "organization" : "workspace";
    if (
      !ids.has(row.id) &&
      !providerLevels.has(providerLevelKey(row.provider, level))
    ) {
      continue;
    }
    const app = getApp(row.provider);
    if (!app) continue;
    const label = row.label
      ? cleanLabel(row.label, MAX_AGENT_CONNECTION_LABEL_CHARS)
      : "";
    out.push({
      provider: row.provider,
      name:
        cleanLabel(app.name, MAX_AGENT_CONNECTION_NAME_CHARS) || row.provider,
      label: label || null,
      host: extractBoundHost(row.metadata),
    });
  }
  return out.slice(0, MAX_AGENT_CONNECTIONS);
};
