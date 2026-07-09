import { getProjectId, getOrganizationId } from "@/lib/api-fetch";
import type { PageScope } from "./scope";

const scope = () =>
  [getOrganizationId() ?? "default", getProjectId() ?? "default"] as const;

export const queryKeys = {
  agents: {
    all: () => ["agents", ...scope()] as const,
    list: () => [...queryKeys.agents.all(), "list"] as const,
    secrets: (agentId: string) =>
      [...queryKeys.agents.all(), agentId, "secrets"] as const,
    connections: (agentId: string) =>
      [...queryKeys.agents.all(), agentId, "connections"] as const,
    granularAccess: () =>
      [...queryKeys.agents.all(), "granular-access"] as const,
  },
  secrets: {
    all: () => ["secrets", ...scope()] as const,
    list: () => [...queryKeys.secrets.all(), "list"] as const,
  },
  rules: {
    all: () => ["rules", ...scope()] as const,
    list: (pageScope: PageScope = "project") =>
      [...queryKeys.rules.all(), "list", pageScope] as const,
  },
  connections: {
    all: () => ["connections", ...scope()] as const,
    list: (pageScope: PageScope = "project") =>
      [...queryKeys.connections.all(), "list", pageScope] as const,
    byProvider: (provider: string) =>
      [...queryKeys.connections.all(), "provider", provider] as const,
    agents: (connectionId: string) =>
      [...queryKeys.connections.all(), connectionId, "agents"] as const,
  },
  appPermissionDefinitions: {
    // Global static catalog (identical across orgs/projects) — deliberately
    // not scope-keyed.
    all: () => ["app-permission-definitions"] as const,
    list: () => [...queryKeys.appPermissionDefinitions.all(), "list"] as const,
  },
  appConfig: {
    all: () => ["appConfig", ...scope()] as const,
    status: (provider: string, pageScope: PageScope) =>
      [...queryKeys.appConfig.all(), provider, pageScope] as const,
    configured: (pageScope: PageScope) =>
      [...queryKeys.appConfig.all(), "configured", pageScope] as const,
    envDefaults: () => [...queryKeys.appConfig.all(), "envDefaults"] as const,
  },
  counts: {
    all: () => ["counts", ...scope()] as const,
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
  appBlocklist: {
    all: () => ["appBlocklist", ...scope()] as const,
    byProvider: (provider: string) =>
      [...queryKeys.appBlocklist.all(), provider] as const,
  },
  billing: {
    all: () => ["billing", ...scope()] as const,
    agentCost: () => [...queryKeys.billing.all(), "agentCost"] as const,
    planUsage: () => [...queryKeys.billing.all(), "planUsage"] as const,
    subscriptionStatus: () =>
      [...queryKeys.billing.all(), "subscriptionStatus"] as const,
    prorationPreview: (plan: string) =>
      [...queryKeys.billing.all(), "prorationPreview", plan] as const,
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
