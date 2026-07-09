export interface PolicyRuleItem {
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
  scope?: string | null;
  metadata?: unknown;
  conditions?: unknown;
  createdAt: string;
}

export interface AgentOption {
  id: string;
  name: string;
}
