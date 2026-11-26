import type {
  WebhookDisabledReason,
  WebhookInput,
  WebhookOutcome,
  WebhookUpdate,
} from "@onecli/api/validations/webhooks";
import { apiDelete, apiGet, apiPatch, apiPost } from "./client";

/**
 * The agent-webhooks client (plans/agent-webhooks.md):
 * /v1/agents/:agentId/webhooks. The row type mirrors the service view
 * (`AgentWebhookView`), dates as ISO strings — the house convention for the
 * typed client; the unions and the input shapes are the API's own.
 */

export type { WebhookInput, WebhookUpdate };

export interface AgentWebhook {
  id: string;
  agentId: string;
  name: string;
  instructions: string;
  /** The public catch URL an external app POSTs to. Holding it = firing it. */
  url: string;
  enabled: boolean;
  /** Set only when the platform turned it off. */
  disabledReason: WebhookDisabledReason | null;
  lastReceivedAt: string | null;
  lastOutcome: WebhookOutcome | null;
  createdAt: string;
}

// Encoded like `crons`: the agent id can arrive DECODED from the URL
// (`useParams`), and an unencoded crafted segment would URL-normalize the
// request onto a different /v1 path under the caller's credentials.
const base = (agentId: string, sub = "") =>
  `/v1/agents/${encodeURIComponent(agentId)}/webhooks${sub}`;

export const list = (agentId: string) =>
  apiGet<{ webhooks: AgentWebhook[] }>(base(agentId));

export const create = (agentId: string, input: WebhookInput) =>
  apiPost<AgentWebhook>(base(agentId), input);

export const update = (
  agentId: string,
  webhookId: string,
  input: WebhookUpdate,
) =>
  apiPatch<AgentWebhook>(
    base(agentId, `/${encodeURIComponent(webhookId)}`),
    input,
  );

export const remove = (agentId: string, webhookId: string) =>
  apiDelete(base(agentId, `/${encodeURIComponent(webhookId)}`));
