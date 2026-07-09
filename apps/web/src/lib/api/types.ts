export interface Agent {
  id: string;
  name: string;
  identifier: string;
  accessToken: string;
  isDefault: boolean;
  secretMode: string;
  createdAt: string;
  _count: { agentSecrets: number; agentAppConnections: number };
}

export interface CreatedAgent {
  id: string;
  name: string;
  identifier: string;
  createdAt: string;
}

export interface AgentGranularAccess {
  agentId: string;
  agentName: string;
  connectionId: string;
  provider: string;
  connectionLabel: string | null;
  policy: Record<string, unknown>;
}

export interface AgentConnection {
  appConnectionId: string;
  sessionPolicy: Record<string, unknown> | null;
}

export interface DropboxFolder {
  id: string;
  name: string;
  pathLower: string;
  pathDisplay: string;
}

export interface Secret {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  valueSource: string;
  opRef: string | null;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  metadata: Record<string, unknown> | null;
  scope: string | null;
  createdAt: string;
}

export interface CreatedSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string;
  pathPattern: string | null;
  createdAt: string;
  preview: string;
}

export interface PolicyRule {
  id: string;
  name: string;
  /** Custom rules only — app-permission rules omit the endpoint fields. */
  hostPattern?: string;
  pathPattern?: string | null;
  method?: string | null;
  action: string;
  enabled: boolean;
  agentId: string | null;
  rateLimit: number | null;
  rateLimitWindow: string | null;
  scope: string | null;
  metadata: unknown;
  conditions: unknown;
  createdAt: string;
}

export interface Connection {
  id: string;
  provider: string;
  label: string | null;
  status: string;
  scopes: string[];
  scope: string | null;
  metadata: unknown;
  connectedAt: string;
}

export type ConnectionAccessLevel = "full" | "assigned" | "none";

// Reverse view of agent↔connection access: an agent and whether it can use a
// given connection. "full" = all-mode agent (implicit access, read-only here);
// "assigned" = selective agent granted this connection; "none" = neither.
// `scoped` flags an assigned agent whose grant carries a granular session
// policy (managed on the agent side; shown read-only here).
export interface ConnectionAgentAccess {
  id: string;
  name: string;
  access: ConnectionAccessLevel;
  scoped: boolean;
}

export interface ResourceCounts {
  agents: number;
  apps: number;
  llms: number;
  secrets: number;
}

export interface CreateAgentInput {
  name: string;
  identifier: string;
}

export interface CreateSecretInput {
  name: string;
  type: string;
  value?: string;
  valueSource?: "inline" | "onepassword";
  opRef?: string;
  opDisplay?: { vault: string; item: string; field: string };
  hostPattern: string;
  pathPattern?: string;
  injectionConfig?: unknown;
}

export interface CreateRuleInput {
  name: string;
  hostPattern: string;
  pathPattern?: string | null;
  method?: string | null;
  action: string;
  enabled?: boolean;
  agentId?: string | null;
  rateLimit?: number | null;
  rateLimitWindow?: string | null;
  conditions?: unknown[];
}

// `conditions: null` clears existing conditions on update.
export type UpdateRuleInput = Partial<Omit<CreateRuleInput, "conditions">> & {
  conditions?: unknown[] | null;
};
