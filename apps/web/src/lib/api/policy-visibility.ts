"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, queryKeys } from "@/lib/api";
import type { PageScope } from "@/lib/api";

// The policy-visibility client: the 9.7b read-only reflections (the equipment
// panels). The project/agent/connection reflect endpoints mount in the shared
// app for every edition; only the org-scoped variant is EE-registered. Query
// keys are built by SPREADING the shared namespaces (`queryKeys.agents.all()`
// etc.), so the arrays are byte-identical to nested entries and every broad
// shared invalidation (`invalidateQueries({ queryKey: queryKeys.agents.all() })`)
// still covers these caches.

export type EffectiveToolVerdict =
  | "allow"
  | "approval"
  | "block"
  | "mixed"
  | "unmanaged";

/** The deciding rule, trimmed for display — never the full targets/identities. */
export interface ProvenanceRuleRef {
  logicalId: string;
  name: string;
  source: string;
  action: "allow" | "block";
  requireApproval: boolean;
  rateLimit: number | null;
  rateLimitWindow: string | null;
}

export type EffectiveProvenance =
  | { kind: "rule"; scope: "organization"; redacted: true }
  | { kind: "rule"; scope: "organization" | "project"; rule: ProvenanceRuleRef }
  | { kind: "default"; scope: "organization" | "project" };

/** What the org level ALONE says about the tool — the ceiling the project can
 * tighten under but never loosen past. Null = the org is silent. */
export type OrgCeilingVerdict = "allow" | "approval" | "block";

export interface EffectiveToolResult {
  toolId: string;
  verdict: EffectiveToolVerdict;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  decidedBy: EffectiveProvenance | null;
  orgCeiling: OrgCeilingVerdict | null;
}

export interface EffectiveToolGroupResult {
  category: "read" | "write";
  verdict: EffectiveToolVerdict;
  tools: EffectiveToolResult[];
}

export interface EffectiveAppPermissionsResult {
  provider: string;
  basis: {
    agentId: string | null;
    credentialAttached: boolean;
    scope: "organization" | "project";
  };
  /** Identity-scoped provider-relevant rules the agent-less baseline can't
   * show — viewer-scoped like bodyConditionsSkipped. */
  variesByIdentity: number;
  groups: EffectiveToolGroupResult[];
}

/**
 * The App Permissions panel's read-only reflection: per-tool effective
 * verdicts from the ENFORCED (published) rules. Project scope takes an optional
 * agent (omitted = the agent-less baseline); the org scope is agent-less by
 * construction. Org-rule provenance arrives redacted for non-org-admins.
 */
export const effectiveAppPermissions = (
  provider: string,
  opts: { agentId?: string; connectionId?: string; scope?: PageScope } = {},
) => {
  const params = new URLSearchParams({ provider });
  if (opts.agentId) params.set("agentId", opts.agentId);
  // Project scope only: reflect one specific account as the winning injected
  // connection (per-account rules bind exactly as the gateway would).
  if (opts.connectionId) params.set("connectionId", opts.connectionId);
  const base =
    (opts.scope ?? "project") === "organization"
      ? "/v1/org/policy"
      : "/v1/policy";
  return apiGet<EffectiveAppPermissionsResult>(
    `${base}/effective-app-permissions?${params}`,
  );
};

/** The App Permissions panel's read-only reflection (step 9.7b):
 * per-tool effective verdicts from the ENFORCED rules. `agentId` null = the
 * agent-less baseline. */
export const useEffectiveAppPermissions = (
  provider: string,
  agentId: string | null,
  scope: PageScope = "project",
  enabled = true,
  /** Reflect one specific account (project scope); null = the provider view. */
  connectionId: string | null = null,
) =>
  useQuery({
    queryKey: [
      ...queryKeys.policy.all(),
      "effective-app-permissions",
      scope,
      provider,
      agentId ?? "baseline",
      connectionId ?? "provider-level",
    ],
    queryFn: () =>
      effectiveAppPermissions(provider, {
        agentId: agentId ?? undefined,
        connectionId: connectionId ?? undefined,
        scope,
      }),
    enabled: enabled && provider.length > 0,
  });

export type CredentialProvenance =
  | { kind: "rule"; scope: "organization"; redacted: true }
  | {
      kind: "rule";
      scope: "organization" | "project";
      rule: { logicalId: string; name: string };
    };

/** What a credential can actually DO under the rules (the effective view). */
export type CredentialAccessStatus =
  | "usable"
  | "limited"
  | "blocked"
  | "unknown";

export type EffectiveCredentialEntry =
  | {
      kind: "secret";
      id: string;
      name: string;
      host: string;
      status: CredentialAccessStatus;
      provenance: CredentialProvenance[];
    }
  | {
      kind: "connection";
      id: string;
      label: string | null;
      provider: string;
      status: CredentialAccessStatus;
      provenance: CredentialProvenance[];
    };

export interface EffectiveCredentialsResult {
  agentId: string;
  /** Demoted to a footnote in the UI — never the headline. */
  mode: "all" | "selective";
  secrets: EffectiveCredentialEntry[];
  connections: EffectiveCredentialEntry[];
}

/** The Credential-access dialog's read-only reflection: which
 * credentials can inject for this agent (its published rule grants). Project
 * members; org-rule provenance arrives redacted for non-org-admins. */
export const effectiveCredentials = (agentId: string) =>
  apiGet<EffectiveCredentialsResult>(
    `/v1/agents/${agentId}/effective-credentials`,
  );

/** The Credential-access dialog's read-only reflection (step 9.7b):
 * which credentials can inject for this agent (its published rule grants). */
export const useEffectiveCredentials = (agentId: string, enabled = true) =>
  useQuery({
    queryKey: [...queryKeys.agents.all(), agentId, "effective-credentials"],
    queryFn: () => effectiveCredentials(agentId),
    enabled: enabled && agentId.length > 0,
  });

export type AgentCredentialStatus =
  | { status: "full" }
  | { status: "viaRule"; provenance: CredentialProvenance[] }
  | { status: "none" };

/** The effective-access headline for an agent on a connection. */
export type AgentAccessStatus =
  | "usable"
  | "limited"
  | "blocked"
  | "none"
  | "unknown";

export interface EffectiveAgentEntry {
  agentId: string;
  name: string;
  access: AgentAccessStatus;
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
  /** false = no permission catalog — the decisions axis is honestly absent. */
  catalog: boolean;
  agents: EffectiveAgentEntry[];
}

/** The "agent access" dialog's read-only reflection: per-agent
 * credential status + the per-tool decisions rollup, from the ENFORCED rules.
 * Project members; org-rule provenance arrives redacted for non-org-admins. */
export const effectiveAgents = (connectionId: string) =>
  apiGet<EffectiveAgentsResult>(
    `/v1/connections/${connectionId}/effective-agents`,
  );

/** The "agent access" dialog's read-only reflection (step 9.7b):
 * per-agent credential status + the decisions rollup from the ENFORCED rules. */
export const useConnectionEffectiveAgents = (
  connectionId: string,
  enabled = true,
) =>
  useQuery({
    queryKey: [
      ...queryKeys.connections.all(),
      connectionId,
      "effective-agents",
    ],
    queryFn: () => effectiveAgents(connectionId),
    enabled: enabled && connectionId.length > 0,
  });
