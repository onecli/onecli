import { apiGet, apiPost } from "./client";
import type { Agent, CreatedAgent, CreateAgentInput } from "./types";

export const list = () => apiGet<Agent[]>("/v1/agents");

export const create = (input: CreateAgentInput) =>
  apiPost<CreatedAgent>("/v1/agents", input);
