import type {
  AgentRuntimeUsage,
  OrgRuntimeUsage,
} from "@onecli/api/validations/usage";
import { apiGet } from "./client";

/**
 * The RUNTIME USAGE client (awake time): one agent's at
 * /v1/agents/:agentId/usage, the org's per-agent totals at /v1/usage/runtime.
 * The shapes are the API's own (`validations/usage`), so the two sides cannot
 * drift. A window is a pair of UTC dates (YYYY-MM-DD), both optional.
 */

export type { AgentRuntimeUsage, OrgRuntimeUsage };

export interface UsageWindowQuery {
  from?: string;
  to?: string;
}

const query = ({ from, to }: UsageWindowQuery) => {
  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const qs = q.toString();
  return qs ? `?${qs}` : "";
};

/** The first day of the current UTC month, as the window's `from`. */
export const thisMonthFrom = (): string => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

export const agent = (agentId: string, window: UsageWindowQuery = {}) =>
  apiGet<AgentRuntimeUsage>(
    `/v1/agents/${encodeURIComponent(agentId)}/usage${query(window)}`,
  );

export const org = (window: UsageWindowQuery = {}) =>
  apiGet<OrgRuntimeUsage>(`/v1/usage/runtime${query(window)}`);
