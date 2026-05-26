import { apiGet, apiPost } from "./client";
import type { PolicyRule, CreateRuleInput } from "./types";

export const list = () => apiGet<PolicyRule[]>("/v1/rules");

export const create = (input: CreateRuleInput) =>
  apiPost<PolicyRule>("/v1/rules", input);
