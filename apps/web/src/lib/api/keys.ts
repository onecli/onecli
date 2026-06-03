import { getProjectId, getOrganizationId } from "@/lib/api-fetch";

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
  },
  secrets: {
    all: () => ["secrets", ...scope()] as const,
    list: () => [...queryKeys.secrets.all(), "list"] as const,
  },
  rules: {
    all: () => ["rules", ...scope()] as const,
    list: () => [...queryKeys.rules.all(), "list"] as const,
  },
  connections: {
    all: () => ["connections", ...scope()] as const,
    list: () => [...queryKeys.connections.all(), "list"] as const,
    byProvider: (provider: string) =>
      [...queryKeys.connections.all(), "provider", provider] as const,
  },
  counts: {
    all: () => ["counts", ...scope()] as const,
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
  appBlocklist: {
    all: () => ["appBlocklist", ...scope()] as const,
    byProvider: (provider: string) =>
      [...queryKeys.appBlocklist.all(), provider] as const,
  },
  billing: {
    all: () => ["billing", ...scope()] as const,
    agentCost: () => [...queryKeys.billing.all(), "agentCost"] as const,
  },
};
