import { apiDelete, apiGet, apiPatch, apiPost } from "./client";

/**
 * The agent-schedules client (step 7): /v1/agents/:agentId/crons. Types are
 * hand-mirrored from the service view (`agent-cron-service.ts`), dates as
 * ISO strings — the house convention for the typed client.
 */

export interface AgentCron {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  /** Set only by auto-disable: "authorization" | "failures". */
  disabledReason: string | null;
  nextFireAt: string;
  lastFiredAt: string | null;
  /** "ok" | "failed" | "skipped_busy" */
  lastOutcome: string | null;
  consecutiveFailures: number;
  createdAt: string;
}

export interface CronInput {
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
}

export interface CronUpdate extends Partial<CronInput> {
  enabled?: boolean;
}

// Encoded like `agents.get`: the agent id can arrive DECODED from the URL
// (`useParams`), and an unencoded crafted segment would URL-normalize the
// request onto a different /v1 path under the caller's credentials.
const cronBase = (agentId: string, sub = "") =>
  `/v1/agents/${encodeURIComponent(agentId)}/crons${sub}`;

export const list = (agentId: string) =>
  apiGet<{ crons: AgentCron[] }>(cronBase(agentId));

export const create = (agentId: string, input: CronInput) =>
  apiPost<AgentCron>(cronBase(agentId), input);

export const update = (agentId: string, cronId: string, input: CronUpdate) =>
  apiPatch<AgentCron>(
    cronBase(agentId, `/${encodeURIComponent(cronId)}`),
    input,
  );

/** Force-fire: pulls nextFireAt to now; the normal poll does the rest. */
export const runNow = (agentId: string, cronId: string) =>
  apiPost<AgentCron>(
    cronBase(agentId, `/${encodeURIComponent(cronId)}/run`),
    {},
  );

export const remove = (agentId: string, cronId: string) =>
  apiDelete(cronBase(agentId, `/${encodeURIComponent(cronId)}`));
