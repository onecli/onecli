import type {
  RunAppCall,
  RunDetail,
  RunListItem,
  RunsPage,
  RunToolCall,
} from "@onecli/api/validations/runs";
import { apiGet } from "./client";

/**
 * The RUNS client (audit): a runs list at /v1/runs (the workspace's, for
 * Activity) or /v1/agents/:agentId/runs (one agent's), and one run in full at
 * /v1/agents/:agentId/runs/:turnId. The shapes are the API's own
 * (`validations/runs`), so the two sides cannot drift.
 */

export type { RunAppCall, RunDetail, RunListItem, RunsPage, RunToolCall };

export interface RunsFilter {
  /** One agent's runs; omitted, the whole workspace's. */
  agentId?: string;
  source?: string;
  failed?: boolean;
  before?: string;
}

const agentRuns = (agentId: string) =>
  `/v1/agents/${encodeURIComponent(agentId)}/runs`;

/** A page of runs, newest first. */
export const list = ({ agentId, source, failed, before }: RunsFilter = {}) => {
  const q = new URLSearchParams();
  if (source) q.set("source", source);
  if (failed) q.set("failed", "true");
  if (before) q.set("before", before);
  const qs = q.toString();
  const path = agentId ? agentRuns(agentId) : "/v1/runs";
  return apiGet<RunsPage>(qs ? `${path}?${qs}` : path);
};

export const get = (agentId: string, turnId: string) =>
  apiGet<{ run: RunDetail }>(
    `${agentRuns(agentId)}/${encodeURIComponent(turnId)}`,
  );
