"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet, apiPost, queryKeys } from "@/lib/api";
import type { PageScope } from "@/lib/api";

// The EE policy-visibility surface: the what-if simulator, the step-9
// resolved-identity read, and the 9.7b read-only reflections. The backing
// endpoints are EE-registered (policy-simulate / policy-reflect /
// agent-resolved-identity), so the whole client family lives in the EE
// overlay — the shared `lib/api` carries no trace of it. Query keys are built
// by SPREADING the shared namespaces (`queryKeys.agents.all()` etc.), so the
// arrays are byte-identical to nested entries and every broad shared
// invalidation (`invalidateQueries({ queryKey: queryKeys.agents.all() })`)
// still covers these caches.

// ── What-if simulator ────────────────────────────────────────────────────────

export interface SimulateInput {
  agentId: string;
  host: string;
  path?: string;
  method: string;
  includeStaged?: boolean;
  hasInjectionsOverride?: boolean;
}

export interface SimulatedRuleRef {
  logicalId: string;
  name: string;
  source: string;
  action: "allow" | "block";
  requireApproval: boolean;
  rateLimit: number | null;
  rateLimitWindow: string | null;
}

/** Who decided the simulated request. Org-rule decisions arrive REDACTED for
 * non-org-admin viewers (verdict only, no name/details). */
export type SimulatedDecidedBy =
  | { kind: "rule"; scope: "organization"; redacted: true }
  | { kind: "rule"; scope: "organization" | "project"; rule: SimulatedRuleRef }
  | { kind: "default"; scope: "organization" | "project"; action: "block" }
  | { kind: "none"; managed: boolean };

export interface SimulateResult {
  decision: {
    action: "allow" | "block";
    requireApproval?: boolean;
    rateLimit?: number;
    rateLimitWindow?: string;
    byDefault?: boolean;
  };
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
  /** Rules with body conditions the simulator can't evaluate (no body input) —
   * scoped to the viewer's visibility (org rules excluded for non-admins). */
  bodyConditionsSkipped: number;
}

/**
 * The what-if simulator (project scope only — a simulation is agent+project
 * contextual): evaluate a hypothetical request against the current rules with
 * the real engine; nothing is sent. Org-rule decisions arrive redacted for
 * non-org-admins.
 */
export const simulate = (input: SimulateInput) =>
  apiPost<SimulateResult>("/v1/policy/simulate", input);

/** The what-if simulator — a pure computation POST (no cache side effects). */
export const useSimulatePolicy = () =>
  useMutation({
    mutationFn: (input: SimulateInput) => simulate(input),
    onError: (err: Error) => toast.error(err.message),
  });

// ── Resolved identity (step 9 visibility) ───────────────────────────────────

/** The principal set the policy engine matches an agent's requests against
 * (org-admin-only read). */
export interface ResolvedIdentity {
  agent: { id: string; name: string };
  agentGroups: { id: string; name: string }[];
  users: { id: string; name: string | null; email: string }[];
  groups: { id: string; name: string }[];
}

/** Who the policy engine thinks this agent is (org-admin-only; 403 otherwise). */
export const resolvedIdentity = (agentId: string) =>
  apiGet<ResolvedIdentity>(`/v1/agents/${agentId}/resolved-identity`);

/** The agent's engine-resolved principal set (step 9 visibility). Org-admin
 * only — the 403 for members is expected, so never retry it. */
export const useResolvedIdentity = (agentId: string, enabled = true) =>
  useQuery({
    queryKey: [...queryKeys.agents.all(), agentId, "resolved-identity"],
    queryFn: () => resolvedIdentity(agentId),
    enabled: enabled && agentId.length > 0,
    retry: false,
  });

// ── Step 9.7b read-only reflections (the equipment panels) ──────────

export type EffectiveToolVerdict =
  | "allow"
  | "approval"
  | "block"
  | "mixed"
  | "unmanaged";

export type EffectiveProvenance =
  | { kind: "rule"; scope: "organization"; redacted: true }
  | { kind: "rule"; scope: "organization" | "project"; rule: SimulatedRuleRef }
  | { kind: "default"; scope: "organization" | "project" };

export interface EffectiveToolResult {
  toolId: string;
  verdict: EffectiveToolVerdict;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  decidedBy: EffectiveProvenance | null;
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
  opts: { agentId?: string; scope?: PageScope } = {},
) => {
  const params = new URLSearchParams({ provider });
  if (opts.agentId) params.set("agentId", opts.agentId);
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
) =>
  useQuery({
    queryKey: [
      ...queryKeys.policy.all(),
      "effective-app-permissions",
      scope,
      provider,
      agentId ?? "baseline",
    ],
    queryFn: () =>
      effectiveAppPermissions(provider, {
        agentId: agentId ?? undefined,
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
