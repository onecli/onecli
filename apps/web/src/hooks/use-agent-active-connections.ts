"use client";

import type { AgentGrants } from "@/lib/api";
import { useConnections } from "@/hooks/use-connections";
import { useAgentGrants } from "@/hooks/use-grants";
import { useSecrets } from "@/hooks/use-secrets";
import {
  useEffectiveCredentials,
  type EffectiveCredentialsResult,
} from "@/lib/api/policy-visibility";

/** One agent's active connection and secret ids. */
export interface AgentActiveSets {
  isActiveApp: (connectionId: string) => boolean;
  isActiveSecret: (secretId: string) => boolean;
}

const orgGranted = (entries: EffectiveCredentialsResult["connections"]) =>
  new Set(
    entries
      .filter((e) => e.provenance.some((p) => p.scope === "organization"))
      .map((e) => e.id),
  );

/**
 * What is ACTIVE for one agent: switched on for it (its own grant) or
 * granted by the organization, the same rule the rows' switches render
 * (`granted || orgGranted`). The tabs' active/inactive split, their badges
 * and the rail badge all read it, so none can disagree with a switch.
 */
export const agentActiveSets = (
  grants: AgentGrants | undefined,
  credentials: EffectiveCredentialsResult | undefined,
): AgentActiveSets => {
  const apps = new Set((grants?.connections ?? []).map((g) => g.connectionId));
  const secrets = new Set((grants?.secrets ?? []).map((s) => s.secretId));
  const orgApps = orgGranted(credentials?.connections ?? []);
  const orgSecrets = orgGranted(credentials?.secrets ?? []);
  return {
    isActiveApp: (id) => apps.has(id) || orgApps.has(id),
    isActiveSecret: (id) => secrets.has(id) || orgSecrets.has(id),
  };
};

/**
 * How many connected apps and custom secrets are active for one agent, for
 * the Connections tab badges and the rail. Undefined while any input loads.
 * The queries are the tabs' own (same keys), so this adds no fetch.
 */
export const useAgentActiveConnections = (
  agentId: string,
): { appCount: number | undefined; secretCount: number | undefined } => {
  const { data: connections } = useConnections("workspace");
  const { data: secrets } = useSecrets();
  const { data: grants } = useAgentGrants(agentId);
  const { data: credentials } = useEffectiveCredentials(agentId);
  if (!connections || !secrets || !grants || !credentials) {
    return { appCount: undefined, secretCount: undefined };
  }
  const { isActiveApp, isActiveSecret } = agentActiveSets(grants, credentials);
  return {
    appCount: connections.filter(
      (c) => c.status === "connected" && isActiveApp(c.id),
    ).length,
    secretCount: secrets.filter(
      (s) => s.type === "generic" && isActiveSecret(s.id),
    ).length,
  };
};
