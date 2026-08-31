import { getWorkspaceId, getOrganizationId } from "@/lib/api-fetch";
import type { PageScope } from "./scope";

const scope = () =>
  [getOrganizationId() ?? "default", getWorkspaceId() ?? "default"] as const;

export const queryKeys = {
  agents: {
    // The namespace root — the ONE key that sweeps both the URL-scoped keys
    // below AND the deliberately unscoped for-workspace keys (the sidebar's
    // rows). Mutations that change agent facts chrome renders (rows, names,
    // attached channels) invalidate this; all() misses for-workspace.
    root: () => ["agents"] as const,
    all: () => [...queryKeys.agents.root(), ...scope()] as const,
    list: () => [...queryKeys.agents.all(), "list"] as const,
    detail: (agentId: string) =>
      [...queryKeys.agents.all(), "detail", agentId] as const,
    models: (agentId: string) =>
      [...queryKeys.agents.all(), "models", agentId] as const,
    // Explicitly-targeted workspace (the org-level picker, the sidebar) —
    // keyed by that workspace, deliberately outside the URL-derived scope()
    // prefix. Under root(), so the namespace sweep still reaches it.
    forWorkspace: (workspaceId: string) =>
      [...queryKeys.agents.root(), "for-workspace", workspaceId] as const,
  },
  conversations: {
    all: () => ["conversations", ...scope()] as const,
    // The agent's one direct thread (§3.18) — keyed by agent, because that is
    // how the door addresses it; the row's own id lives in the cached value.
    // Its query is backed by a PUT, so only ever invalidate it deliberately
    // (deleting the agent) — never as part of a namespace sweep.
    direct: (agentId: string) =>
      [...queryKeys.conversations.all(), "direct", agentId] as const,
    turns: (conversationId: string) =>
      [...queryKeys.conversations.all(), "turns", conversationId] as const,
    // No transcript key: the live transcript is the stream's local state, on
    // purpose — a cache entry would invite a second source of truth.
  },
  attachments: {
    all: () => ["attachments", ...scope()] as const,
    // Immutable bytes keyed by id — fetched once (staleTime: Infinity) into
    // an object URL for chip previews and downloads.
    blob: (conversationId: string, attachmentId: string) =>
      [
        ...queryKeys.attachments.all(),
        "blob",
        conversationId,
        attachmentId,
      ] as const,
  },
  secrets: {
    all: () => ["secrets", ...scope()] as const,
    list: () => [...queryKeys.secrets.all(), "list"] as const,
  },
  policy: {
    all: () => ["policy", ...scope()] as const,
    rules: (pageScope: PageScope = "workspace") =>
      [...queryKeys.policy.all(), "rules", pageScope] as const,
    default: (pageScope: PageScope = "workspace") =>
      [...queryKeys.policy.all(), "default", pageScope] as const,
    lastPublish: (pageScope: PageScope = "workspace") =>
      [...queryKeys.policy.all(), "last-publish", pageScope] as const,
  },
  domains: {
    all: () => ["domains", ...scope()] as const,
    list: () => [...queryKeys.domains.all(), "list"] as const,
  },
  groups: {
    all: () => ["groups", ...scope()] as const,
    list: () => [...queryKeys.groups.all(), "list"] as const,
    members: (groupId: string) =>
      [...queryKeys.groups.all(), groupId, "members"] as const,
  },
  roleMappings: {
    all: () => ["role-mappings", ...scope()] as const,
    list: () => [...queryKeys.roleMappings.all(), "list"] as const,
  },
  invitations: {
    all: () => ["invitations", ...scope()] as const,
    list: () => [...queryKeys.invitations.all(), "list"] as const,
  },
  org: {
    // The current-org read (GET /v1/org), keyed per URL scope like every
    // other namespace. On /w/ pages the org slot is "default" (the org-id
    // regex only matches /org/ paths) and the WORKSPACE id is the real
    // discriminator — globally unique, so entries never bleed across orgs; a
    // workspace switch re-fetches, accepted for a one-row read. A consumer on
    // a route matching NEITHER regex would key to ["org","default","default"]
    // and must not trust that entry across org switches.
    all: () => ["org", ...scope()] as const,
  },
  orgMembers: {
    all: () => ["org-members", ...scope()] as const,
    list: () => [...queryKeys.orgMembers.all(), "list"] as const,
  },
  ssoConnections: {
    all: () => ["sso-connections", ...scope()] as const,
    list: () => [...queryKeys.ssoConnections.all(), "list"] as const,
  },
  ssoEnforcement: {
    all: () => ["sso-enforcement", ...scope()] as const,
    get: () => [...queryKeys.ssoEnforcement.all(), "get"] as const,
  },
  scimTokens: {
    all: () => ["scim-tokens", ...scope()] as const,
    list: () => [...queryKeys.scimTokens.all(), "list"] as const,
  },
  grants: {
    all: () => ["grants", ...scope()] as const,
    agent: (agentId: string) =>
      [...queryKeys.grants.all(), "agent", agentId] as const,
    connection: (connectionId: string) =>
      [...queryKeys.grants.all(), "connection", connectionId] as const,
  },
  connections: {
    all: () => ["connections", ...scope()] as const,
    list: (pageScope: PageScope = "workspace") =>
      [...queryKeys.connections.all(), "list", pageScope] as const,
    byProvider: (provider: string) =>
      [...queryKeys.connections.all(), "provider", provider] as const,
  },
  workspaceAccess: {
    all: () => ["workspace-access", ...scope()] as const,
    list: (workspaceId: string) =>
      [...queryKeys.workspaceAccess.all(), workspaceId] as const,
  },
  workspaces: {
    all: () => ["workspaces", ...scope()] as const,
    // organizationId only when explicitly overridden (account-route picker).
    list: (organizationId?: string) =>
      [...queryKeys.workspaces.all(), "list", organizationId ?? "url"] as const,
  },
  appPermissionDefinitions: {
    // Global static catalog (identical across orgs/workspaces) — deliberately
    // not scope-keyed.
    all: () => ["app-permission-definitions"] as const,
    list: () => [...queryKeys.appPermissionDefinitions.all(), "list"] as const,
  },
  awsExternalId: {
    // The org's AWS sts:ExternalId, read from the connect popup — whose
    // pathname is `/app-connect/<provider>` and so carries NO scope for
    // `scope()` to read (the ids are in the query string). Keying on the
    // explicit scope instead of the URL is what keeps two popups opened for
    // different tenants from sharing one cache entry.
    all: (scope?: { workspaceId?: string; orgId?: string }) =>
      [
        "aws-external-id",
        scope?.orgId ?? "-",
        scope?.workspaceId ?? "-",
      ] as const,
  },
  appConfig: {
    all: () => ["appConfig", ...scope()] as const,
    status: (provider: string, pageScope: PageScope) =>
      [...queryKeys.appConfig.all(), provider, pageScope] as const,
    configured: (pageScope: PageScope) =>
      [...queryKeys.appConfig.all(), "configured", pageScope] as const,
    envDefaults: () => [...queryKeys.appConfig.all(), "envDefaults"] as const,
  },
  appAvailability: {
    all: () => ["appAvailability", ...scope()] as const,
    available: () => [...queryKeys.appAvailability.all(), "available"] as const,
  },
  counts: {
    all: () => ["counts", ...scope()] as const,
  },
  // Instance metadata is deployment-global — no org/workspace scope key.
  instance: {
    all: () => ["instance"] as const,
  },
  // Registered SSH keys are PER-USER, not per-org/workspace — deliberately
  // unscoped (the instance precedent) so /account/ssh-keys and the agent SSH
  // page resolve to the SAME cache entry; a scoped key would silently split
  // the two surfaces.
  sshKeys: {
    all: () => ["ssh-keys"] as const,
    list: () => [...queryKeys.sshKeys.all(), "list"] as const,
  },
  installInfo: {
    all: () => ["install-info", ...scope()] as const,
  },
  userPlan: {
    all: () => ["user-plan", ...scope()] as const,
  },
  vaults: {
    all: () => ["vaults", ...scope()] as const,
    list: () => [...queryKeys.vaults.all(), "list"] as const,
  },
  activity: {
    all: () => ["activity", ...scope()] as const,
    list: (filter?: string) =>
      [...queryKeys.activity.all(), "list", filter] as const,
  },
  approvals: {
    all: () => ["approvals", ...scope()] as const,
    list: () => [...queryKeys.approvals.all(), "list"] as const,
  },
  crons: {
    all: () => ["crons", ...scope()] as const,
    agent: (agentId: string) =>
      [...queryKeys.crons.all(), "agent", agentId] as const,
  },
  skills: {
    all: () => ["skills", ...scope()] as const,
    list: () => [...queryKeys.skills.all(), "list"] as const,
    detail: (skillId: string) =>
      [...queryKeys.skills.all(), "detail", skillId] as const,
    org: () => [...queryKeys.skills.all(), "org"] as const,
    orgDetail: (skillId: string) =>
      [...queryKeys.skills.all(), "org", "detail", skillId] as const,
  },
  memories: {
    all: () => ["memories", ...scope()] as const,
    agent: (agentId: string) =>
      [...queryKeys.memories.all(), "agent", agentId] as const,
    detail: (agentId: string, memoryId: string) =>
      [...queryKeys.memories.all(), "detail", agentId, memoryId] as const,
    revisions: (agentId: string, memoryId: string) =>
      [...queryKeys.memories.all(), "revisions", agentId, memoryId] as const,
    revision: (agentId: string, memoryId: string, revisionId: string) =>
      [
        ...queryKeys.memories.all(),
        "revision",
        agentId,
        memoryId,
        revisionId,
      ] as const,
  },
  channels: {
    all: () => ["channels", ...scope()] as const,
    agent: (agentId: string) =>
      [...queryKeys.channels.all(), "agent", agentId] as const,
    manifest: (agentId: string, provider: string, transport?: string) =>
      [
        ...queryKeys.channels.all(),
        "manifest",
        agentId,
        provider,
        // Part of the key: flipping the mode picker must refetch, never serve
        // the other transport's cached manifest.
        transport ?? "default",
      ] as const,
    org: () => [...queryKeys.channels.all(), "org"] as const,
  },
  appBlocklist: {
    all: () => ["appBlocklist", ...scope()] as const,
    byProvider: (provider: string) =>
      [...queryKeys.appBlocklist.all(), provider] as const,
  },
  billing: {
    all: () => ["billing", ...scope()] as const,
    planUsage: () => [...queryKeys.billing.all(), "planUsage"] as const,
    subscriptionStatus: () =>
      [...queryKeys.billing.all(), "subscriptionStatus"] as const,
    prorationPreview: (plan: string, interval: string) =>
      [...queryKeys.billing.all(), "prorationPreview", plan, interval] as const,
  },
  dropbox: {
    all: () => ["dropbox", ...scope()] as const,
    folders: (connectionId: string, path: string) =>
      [...queryKeys.dropbox.all(), "folders", connectionId, path] as const,
  },
  onepassword: {
    all: () => ["onepassword", ...scope()] as const,
    status: () => [...queryKeys.onepassword.all(), "status"] as const,
    vaults: () => [...queryKeys.onepassword.all(), "vaults"] as const,
    items: (vaultId: string) =>
      [...queryKeys.onepassword.all(), "items", vaultId] as const,
    fields: (vaultId: string, itemId: string) =>
      [...queryKeys.onepassword.all(), "fields", vaultId, itemId] as const,
  },
};
