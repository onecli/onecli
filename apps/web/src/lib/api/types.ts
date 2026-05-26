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

export interface Secret {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  hostPattern: string;
  pathPattern: string | null;
  injectionConfig: unknown;
  isPlatform: boolean;
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
  hostPattern: string;
  pathPattern: string | null;
  method: string | null;
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
  value: string;
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
