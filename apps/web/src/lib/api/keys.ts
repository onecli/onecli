export const queryKeys = {
  agents: {
    all: ["agents"] as const,
    list: () => [...queryKeys.agents.all, "list"] as const,
    secrets: (agentId: string) =>
      [...queryKeys.agents.all, agentId, "secrets"] as const,
    connections: (agentId: string) =>
      [...queryKeys.agents.all, agentId, "connections"] as const,
  },
  secrets: {
    all: ["secrets"] as const,
    list: () => [...queryKeys.secrets.all, "list"] as const,
  },
  rules: {
    all: ["rules"] as const,
    list: () => [...queryKeys.rules.all, "list"] as const,
  },
  connections: {
    all: ["connections"] as const,
    list: () => [...queryKeys.connections.all, "list"] as const,
    byProvider: (provider: string) =>
      [...queryKeys.connections.all, "provider", provider] as const,
  },
  counts: {
    all: ["counts"] as const,
  },
  vaults: {
    all: ["vaults"] as const,
    list: () => [...queryKeys.vaults.all, "list"] as const,
  },
  activity: {
    all: ["activity"] as const,
    list: (filter?: string) =>
      [...queryKeys.activity.all, "list", filter] as const,
  },
};
