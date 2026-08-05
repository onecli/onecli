import { apiGet, apiPost } from "./client";
import type {
  Agent,
  AgentDetail,
  CreatedAgent,
  CreateAgentInput,
} from "./types";

// Explicit project targeting exists for the org-level Get Started picker,
// which reads agents of a project the URL doesn't carry. The override wins
// over the path-derived scope (apiFetch spreads options.headers last) and the
// server re-fences it against the caller's memberships.
const projectScope = (projectId?: string): RequestInit | undefined =>
  projectId ? { headers: { "X-Project-Id": projectId } } : undefined;

export const list = (options: { projectId?: string } = {}) =>
  apiGet<Agent[]>("/v1/agents", projectScope(options.projectId));

export const get = (agentId: string) =>
  apiGet<AgentDetail>(`/v1/agents/${agentId}`);

export const create = (input: CreateAgentInput) =>
  apiPost<CreatedAgent>("/v1/agents", input);
