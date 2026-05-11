import type {
  CreatePolicyRuleInput,
  UpdatePolicyRuleInput,
} from "@/lib/validations/policy-rule";

export interface PolicyRuleItem {
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
  scope?: string;
  metadata?: unknown;
  createdAt: Date;
}

export interface AgentOption {
  id: string;
  name: string;
}

export interface RuleActions {
  createRule: (input: CreatePolicyRuleInput) => Promise<unknown>;
  updateRule: (ruleId: string, input: UpdatePolicyRuleInput) => Promise<void>;
  deleteRule: (ruleId: string) => Promise<void>;
}
