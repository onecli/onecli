"use client";

import { useCallback } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { getApp } from "@onecli/api/apps/registry";
import type { AppPermissionDefinitionSummary } from "@onecli/api/apps/app-permissions/types";
import { grants } from "@/lib/api";
import type {
  AgentGrantConnection,
  AgentGrantSecret,
  AgentGrants,
  Connection,
  ConnectionGrantInput,
  ConnectionGrants,
  Secret,
  SecretAgentAccess,
  SecretAgentAccessEntry,
} from "@/lib/api";
import { defaultGrantAccess } from "@/lib/api/default-grant";
import { queryKeys } from "@/lib/api/keys";
import {
  combineRollbacks,
  installItem,
  listItem,
  patchItem,
  throughField,
} from "@/lib/api/optimistic";
import {
  useOptimisticMutation,
  useWriteSettling,
} from "@/hooks/use-optimistic-mutation";

// Grants mutations are headless on the gateway cache: every grants route wraps
// withAudit, which flushes the gateway server-side — no client-side flush
// needed. They are also headless on publish: the server publishes atomically
// inside the mutation.
//
// Every write here is optimistic (see `useOptimisticMutation`): the switch
// moves on click, the agent's and the connection's grant views both update
// at once, writes to one agent × connection pair run in click order whichever
// surface sent them, and a failure puts back that one pair with a toast. The
// effective-access reflections (what the agent can actually DO) are never
// guessed: they refresh once the last grant write settles.

export const useAgentGrants = (agentId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.grants.agent(agentId),
    queryFn: () => grants.forAgent(agentId),
    enabled: enabled && agentId.length > 0,
  });

export const useConnectionGrants = (connectionId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.grants.connection(connectionId),
    queryFn: () => grants.forConnection(connectionId),
    enabled: enabled && connectionId.length > 0,
  });

/** Every agent of the workspace against one secret: the custom connection's
 * "choose agents" window. Keyed under grants: `useAttachSecret` /
 * `useDetachSecret` move its switch at once (optimistic), and every grant
 * write's settle refetches it. */
export const useSecretAgentAccess = (secretId: string, enabled = true) =>
  useQuery({
    queryKey: queryKeys.grants.secret(secretId),
    queryFn: () => grants.forSecret(secretId),
    enabled: enabled && secretId.length > 0,
  });

/** The agents-list chips feed — keyed under the agents namespace so agent CRUD
 * invalidation reaches it (the policy-visibility spread trick). */
export const useGrantsSummary = () =>
  useQuery({
    queryKey: [...queryKeys.agents.all(), "grants-summary"],
    queryFn: grants.summary,
  });

/** Every view a grant write makes stale. Also for writes the SERVER makes on
 * the client's behalf: a connection created from an agent's context arrives
 * already granted to that agent (the API's connecting-agent grant). */
const invalidateGrantViews = (qc: QueryClient) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.grants.all() }),
    // A grant IS a policy write (source-tagged rules + an atomic publish), and
    // the reflections/summary key under these shared namespaces — the same
    // reasoning as use-policy's useInvalidatePolicy: a stale effective verdict
    // reads as a security answer.
    qc.invalidateQueries({ queryKey: queryKeys.policy.all() }),
    qc.invalidateQueries({ queryKey: queryKeys.agents.all() }),
    qc.invalidateQueries({ queryKey: queryKeys.connections.all() }),
  ]);

export const useInvalidateGrants = () => {
  const qc = useQueryClient();
  return useCallback(() => {
    void invalidateGrantViews(qc);
  }, [qc]);
};

/** The family every grant write belongs to: one settle refetch per burst. */
export const GRANTS_FAMILY = "grants";

/** One agent × one credential: the unit writes are ordered and rolled back by. */
const pairKey = (agentId: string, kind: "connection" | "secret", id: string) =>
  `grant:${agentId}:${kind}:${id}`;

/** The toast id a grant write's failure uses for this agent × connection, so
 * a surface's own toast for the click (Undo, Permissions) is REPLACED by the
 * failure instead of standing beside it, offering to undo what never was. */
export const grantToastId = (agentId: string, connectionId: string) =>
  pairKey(agentId, "connection", connectionId);

const agentConnection = (connectionId: string) =>
  throughField<AgentGrants, "connections", AgentGrantConnection>(
    "connections",
    listItem((g) => g.connectionId === connectionId),
  );

const agentSecret = (secretId: string) =>
  throughField<AgentGrants, "secrets", AgentGrantSecret>(
    "secrets",
    listItem((s) => s.secretId === secretId),
  );

const secretAgent = (agentId: string) =>
  throughField<SecretAgentAccess, "agents", SecretAgentAccessEntry>(
    "agents",
    listItem((a) => a.agentId === agentId),
  );

type ConnectionGrantAgent = ConnectionGrants["agents"][number];

const connectionAgent = (agentId: string) =>
  throughField<ConnectionGrants, "agents", ConnectionGrantAgent>(
    "agents",
    listItem((a) => a.agentId === agentId),
  );

/** The connection row as the page already has it, for the label/scope the
 * agent-side grant carries. Any cached connections list will do. */
const cachedConnection = (
  qc: QueryClient,
  connectionId: string,
): Connection | undefined => {
  for (const [, list] of qc.getQueriesData<Connection[]>({
    queryKey: queryKeys.connections.all(),
  })) {
    if (!Array.isArray(list)) continue;
    const found = list.find((c) => c.id === connectionId);
    if (found) return found;
  }
  return undefined;
};

const cachedCatalog = (qc: QueryClient, provider: string) =>
  qc
    .getQueryData<
      AppPermissionDefinitionSummary[]
    >(queryKeys.appPermissionDefinitions.list())
    ?.find((d) => d.provider === provider);

/**
 * The grant a write will leave, as the views read it back. `default` is the
 * attach toggles' request: the product default for the provider, which the
 * catalog the page already loaded predicts exactly (pinned by
 * default-grant.test). Resources follow the server's tri-state: absent keeps
 * what the grant carried, null clears, an object sets.
 */
const nextGrant = (
  input: ConnectionGrantInput,
  previous: { resources: AgentGrantConnection["resources"] } | undefined,
  catalog: AppPermissionDefinitionSummary | undefined,
): Omit<
  AgentGrantConnection,
  "connectionId" | "provider" | "label" | "scope"
> => {
  const resources =
    input.resources === undefined
      ? (previous?.resources ?? null)
      : input.resources;
  if (input.access === "default") {
    return { ...defaultGrantAccess(catalog), resources };
  }
  if (input.access === "full") {
    return {
      access: "full",
      allow: [],
      ask: [],
      otherReads: "allow",
      otherWrites: "allow",
      resources,
    };
  }
  return {
    access: "custom",
    allow: [...input.allow].sort(),
    ask: [...input.ask].sort(),
    otherReads: input.otherReads ?? "ask",
    otherWrites: input.otherWrites ?? "ask",
    resources,
  };
};

/** Show one agent × connection grant as set (or, with `undefined`, removed)
 * in both orientations at once: the agent's view and the connection's. */
const applyConnectionGrant = (
  qc: QueryClient,
  agentId: string,
  connectionId: string,
  input: ConnectionGrantInput | undefined,
) => {
  const connection = cachedConnection(qc, connectionId);
  const agentSide = patchItem(
    qc,
    queryKeys.grants.agent(agentId),
    agentConnection(connectionId),
    (current) => {
      if (input === undefined) return undefined;
      const provider = current?.provider ?? connection?.provider ?? "";
      return {
        connectionId,
        provider,
        label: current?.label ?? connection?.label ?? null,
        scope:
          current?.scope ??
          (connection?.scope === "organization" ? "organization" : "workspace"),
        ...nextGrant(input, current, cachedCatalog(qc, provider)),
      };
    },
  );
  const connectionSide = patchItem(
    qc,
    queryKeys.grants.connection(connectionId),
    connectionAgent(agentId),
    (current) => {
      if (input === undefined) return undefined;
      const provider = connection?.provider ?? "";
      return {
        agentId,
        ...nextGrant(input, current, cachedCatalog(qc, provider)),
      };
    },
  );
  return combineRollbacks(agentSide, connectionSide);
};

/** A grant PUT answers with the agent's whole grants: install it, and its
 * entry for this connection into the connection's view. */
const confirmConnectionGrant = (
  qc: QueryClient,
  result: AgentGrants,
  agentId: string,
  connectionId: string,
) => {
  if (!result || !Array.isArray(result.connections)) return;
  const grant = result.connections.find((g) => g.connectionId === connectionId);
  // Only this pair: other pairs of the agent may have writes in flight, and
  // the PUT's snapshot would repaint them with what was true when it ran.
  installItem(
    qc,
    queryKeys.grants.agent(agentId),
    agentConnection(connectionId),
    grant,
  );
  installItem(
    qc,
    queryKeys.grants.connection(connectionId),
    connectionAgent(agentId),
    grant && {
      agentId,
      access: grant.access,
      allow: grant.allow,
      ask: grant.ask,
      otherReads: grant.otherReads,
      otherWrites: grant.otherWrites,
      resources: grant.resources,
    },
  );
};

const connectionName = (qc: QueryClient, connectionId: string) => {
  const connection = cachedConnection(qc, connectionId);
  if (!connection) return "this connection";
  return (
    connection.label ?? getApp(connection.provider)?.name ?? connection.provider
  );
};

const hasIdAndName = (value: unknown): value is { id: string; name: string } =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  "name" in value &&
  typeof value.name === "string";

const hasAgentRows = (
  value: unknown,
): value is { agents: { agentId: string; name: string }[] } =>
  typeof value === "object" &&
  value !== null &&
  "agents" in value &&
  Array.isArray(value.agents);

/** The agent's name from whatever view the page has cached: an agents list,
 * the agent page's own detail, or a connection's effective-agents view (the
 * account card). Only for the failure toast's wording. */
const agentName = (qc: QueryClient, agentId: string) => {
  for (const [, data] of qc.getQueriesData({
    queryKey: queryKeys.agents.root(),
  })) {
    const candidates: unknown[] = Array.isArray(data) ? data : [data];
    const found = candidates.find((a) => hasIdAndName(a) && a.id === agentId);
    if (hasIdAndName(found)) return found.name;
  }
  for (const [, data] of qc.getQueriesData({
    queryKey: queryKeys.connections.all(),
  })) {
    if (!hasAgentRows(data)) continue;
    const found = data.agents.find((a) => a?.agentId === agentId);
    if (typeof found?.name === "string") return found.name;
  }
  return "this agent";
};

interface ConnectionGrantVariables {
  agentId: string;
  connectionId: string;
  input: ConnectionGrantInput;
}

interface PairVariables {
  agentId: string;
  connectionId: string;
}

const grantFailure = (
  qc: QueryClient,
  { agentId, connectionId }: PairVariables,
  verb: string,
) =>
  `Couldn't ${verb} ${connectionName(qc, connectionId)} for ${agentName(qc, agentId)}`;

/** Attach, or change, one agent's grant on one connection (agent orientation:
 * the agent page's switches, the attach dialog, the Manage sheet's save). */
export const useSetConnectionGrant = () =>
  useOptimisticMutation<AgentGrants, ConnectionGrantVariables>({
    family: GRANTS_FAMILY,
    itemKey: ({ agentId, connectionId }) =>
      pairKey(agentId, "connection", connectionId),
    write: ({ agentId, connectionId, input }) =>
      grants.setConnectionGrant(agentId, connectionId, input),
    apply: (qc, { agentId, connectionId, input }) =>
      applyConnectionGrant(qc, agentId, connectionId, input),
    confirm: (qc, result, { agentId, connectionId }) =>
      confirmConnectionGrant(qc, result, agentId, connectionId),
    refresh: invalidateGrantViews,
    failure: (qc, variables) =>
      grantFailure(
        qc,
        variables,
        variables.input.access === "default" ? "turn on" : "update",
      ),
  });

export const useDetachConnection = () =>
  useOptimisticMutation<void, PairVariables>({
    family: GRANTS_FAMILY,
    itemKey: ({ agentId, connectionId }) =>
      pairKey(agentId, "connection", connectionId),
    write: ({ agentId, connectionId }) =>
      grants.detachConnection(agentId, connectionId),
    apply: (qc, { agentId, connectionId }) =>
      applyConnectionGrant(qc, agentId, connectionId, undefined),
    refresh: invalidateGrantViews,
    failure: (qc, variables) => grantFailure(qc, variables, "turn off"),
  });

/** The connection-dialog twins (connection orientation: the account card's
 * agent rows, the post-connect Agent access dialog). Same pair queue as the
 * agent orientation, so the two surfaces can never reorder each other. */
export const useSetConnectionGrantForAgent = () =>
  useOptimisticMutation<AgentGrants, ConnectionGrantVariables>({
    family: GRANTS_FAMILY,
    itemKey: ({ agentId, connectionId }) =>
      pairKey(agentId, "connection", connectionId),
    write: ({ connectionId, agentId, input }) =>
      grants.setForConnection(connectionId, agentId, input),
    apply: (qc, { agentId, connectionId, input }) =>
      applyConnectionGrant(qc, agentId, connectionId, input),
    confirm: (qc, result, { agentId, connectionId }) =>
      confirmConnectionGrant(qc, result, agentId, connectionId),
    refresh: invalidateGrantViews,
    failure: (qc, variables) =>
      grantFailure(
        qc,
        variables,
        variables.input.access === "default" ? "turn on" : "restore",
      ),
  });

export const useDetachConnectionForAgent = () =>
  useOptimisticMutation<void, PairVariables>({
    family: GRANTS_FAMILY,
    itemKey: ({ agentId, connectionId }) =>
      pairKey(agentId, "connection", connectionId),
    write: ({ connectionId, agentId }) =>
      grants.detachForConnection(connectionId, agentId),
    apply: (qc, { agentId, connectionId }) =>
      applyConnectionGrant(qc, agentId, connectionId, undefined),
    refresh: invalidateGrantViews,
    failure: (qc, variables) => grantFailure(qc, variables, "turn off"),
  });

interface SecretVariables {
  agentId: string;
  secretId: string;
}

const cachedSecret = (qc: QueryClient, secretId: string) => {
  for (const [, list] of qc.getQueriesData<Secret[]>({
    queryKey: queryKeys.secrets.all(),
  })) {
    if (!Array.isArray(list)) continue;
    const found = list.find((s) => s.id === secretId);
    if (found) return found;
  }
  return undefined;
};

const applySecretGrant = (
  qc: QueryClient,
  { agentId, secretId }: SecretVariables,
  attached: boolean,
) => {
  const secret = cachedSecret(qc, secretId);
  const placeholder: AgentGrantSecret = {
    secretId,
    name: secret?.name ?? "",
    type: secret?.type ?? "generic",
    scope: secret?.scope === "organization" ? "organization" : "workspace",
  };
  const agentSide = patchItem(
    qc,
    queryKeys.grants.agent(agentId),
    agentSecret(secretId),
    (current) => (attached ? (current ?? placeholder) : undefined),
  );
  // The secret's own "choose agents" view: the same pair, seen from the
  // secret. Only the workspace grant moves; an org grant is not this switch's.
  const secretSide = patchItem(
    qc,
    queryKeys.grants.secret(secretId),
    secretAgent(agentId),
    (current) => (current ? { ...current, granted: attached } : current),
  );
  return combineRollbacks(agentSide, secretSide);
};

const secretFailure = (
  qc: QueryClient,
  { agentId, secretId }: SecretVariables,
  verb: string,
) =>
  `Couldn't ${verb} ${cachedSecret(qc, secretId)?.name ?? "this key"} for ${agentName(qc, agentId)}`;

export const useAttachSecret = () =>
  useOptimisticMutation<AgentGrants, SecretVariables>({
    family: GRANTS_FAMILY,
    itemKey: ({ agentId, secretId }) => pairKey(agentId, "secret", secretId),
    write: ({ agentId, secretId }) => grants.attachSecret(agentId, secretId),
    apply: (qc, variables) => applySecretGrant(qc, variables, true),
    confirm: (qc, result, { agentId, secretId }) => {
      if (!result || !Array.isArray(result.secrets)) return;
      installItem(
        qc,
        queryKeys.grants.agent(agentId),
        agentSecret(secretId),
        result.secrets.find((s) => s.secretId === secretId),
      );
    },
    refresh: invalidateGrantViews,
    failure: (qc, variables) => secretFailure(qc, variables, "turn on"),
  });

export const useDetachSecret = () =>
  useOptimisticMutation<void, SecretVariables>({
    family: GRANTS_FAMILY,
    itemKey: ({ agentId, secretId }) => pairKey(agentId, "secret", secretId),
    write: ({ agentId, secretId }) => grants.detachSecret(agentId, secretId),
    apply: (qc, variables) => applySecretGrant(qc, variables, false),
    refresh: invalidateGrantViews,
    failure: (qc, variables) => secretFailure(qc, variables, "turn off"),
  });

/** Narrow a pending write's variables to the grant pair it targets. */
export const grantTarget = (
  variables: unknown,
): { agentId: string; connectionId?: string; secretId?: string } | null => {
  if (
    typeof variables !== "object" ||
    variables === null ||
    !("agentId" in variables) ||
    typeof variables.agentId !== "string"
  ) {
    return null;
  }
  return {
    agentId: variables.agentId,
    ...("connectionId" in variables &&
      typeof variables.connectionId === "string" && {
        connectionId: variables.connectionId,
      }),
    ...("secretId" in variables &&
      typeof variables.secretId === "string" && {
        secretId: variables.secretId,
      }),
  };
};

/**
 * Whether a grant write for this agent × credential is still settling. The
 * effective-access pill beside a switch describes the state BEFORE the click
 * until the refetch lands, so rows hide it meanwhile instead of showing a
 * verdict for the old state next to a switch already showing the new one.
 */
export const useGrantSettling = (
  agentId: string,
  kind: "connection" | "secret",
  id: string,
): boolean =>
  useWriteSettling(GRANTS_FAMILY, (variables) => {
    const target = grantTarget(variables);
    if (target === null || target.agentId !== agentId) return false;
    return kind === "connection"
      ? target.connectionId === id
      : target.secretId === id;
  });
