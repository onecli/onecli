import { apiGet } from "./client";

/**
 * The agent RUNS client (audit): GET /v1/agents/:agentId/runs/:turnId, one
 * run in full. Types hand-mirrored from `agent-runs-service.ts`, dates as
 * ISO strings (the house convention for the typed client).
 */

export interface RunToolCall {
  callId: string;
  name: string;
  input: string | null;
  output: string | null;
  isError: boolean;
}

export interface RunAppCall {
  provider: string;
  host: string;
  method: string;
  status: number;
  latencyMs: number;
  at: string;
}

export interface RunSummary {
  turnId: string;
  conversationId: string;
  source: string;
  direct: boolean;
  status: string;
  question: string;
  answer: string | null;
  error: string | null;
  askedBy: { id: string; email: string; name: string | null } | null;
  toolNames: string[];
  /** Gateway evidence is a time-window correlation, never exact attribution. */
  appAttribution: "agent_time_window" | "withheld";
  appsUsed: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface RunDetail extends RunSummary {
  tools: RunToolCall[];
  appCalls: RunAppCall[];
}

export const get = (agentId: string, turnId: string) =>
  apiGet<{ run: RunDetail }>(
    `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(turnId)}`,
  );
