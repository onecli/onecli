import type { ScheduleParse } from "@onecli/api/services/schedule-parse-service";
import type { CronOutcome } from "@onecli/api/validations/crons";
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
  /** Shell command run before each fire, no model; null = none. */
  gate: string | null;
  /** The run condition in plain words, written by the agent. */
  gateDescription: string | null;
  enabled: boolean;
  /** Set only by auto-disable: "authorization" | "failures". */
  disabledReason: string | null;
  nextFireAt: string;
  lastFiredAt: string | null;
  /** How the last finished run went. */
  lastOutcome: CronOutcome | null;
  /** Its conversation is busy right now (a run, or a person's follow-up in
   * it); derived server-side. */
  running: boolean;
  consecutiveFailures: number;
  createdAt: string;
}

export interface CronInput {
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  gate?: string | null;
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

/** "When" words the dialog's own rules missed, read by a fast model on the
 * agent's key. Saves nothing. */
export const parseWords = (
  agentId: string,
  input: { text: string; timezone: string },
) => apiPost<ScheduleParse>(cronBase(agentId, "/parse"), input);

export const remove = (agentId: string, cronId: string) =>
  apiDelete(cronBase(agentId, `/${encodeURIComponent(cronId)}`));
