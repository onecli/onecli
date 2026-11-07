import { z } from "zod";

/**
 * Agent webhooks (plans/agent-webhooks.md): the Zod surfaces for the routes,
 * plus the unions and bounds the service, the settle chain, and the web read.
 * A LEAF module on purpose (zod only): turn-service imports from here, and
 * the webhook service imports from turn-service, so anything shared by both
 * must live below them.
 */

/** Why the platform turned a webhook off (never set by the user's pause). */
export const WEBHOOK_DISABLED_REASONS = [
  // The creator lost workspace access: the URL they minted must not keep a
  // foothold (the cron rule).
  "authorization",
  // WEBHOOK_FAILURE_DISABLE_THRESHOLD consecutive failed runs.
  "failures",
] as const;
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];

export const WEBHOOK_OUTCOMES = ["ok", "failed"] as const;
export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number];

/** Consecutive failed runs before a webhook turns itself off (cron's bar). */
export const WEBHOOK_FAILURE_DISABLE_THRESHOLD = 5;

/**
 * Webhooks one agent may hold. An availability bound, not a product limit:
 * every webhook is a public URL that can queue work, so a cap keeps one
 * agent from accumulating an unbounded set of them.
 */
export const MAX_WEBHOOKS_PER_AGENT = 10;

/** Largest request body accepted at `POST /v1/hooks/:token`; bigger → 413. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * How much of the payload reaches the model. The body cap above is about
 * ACCEPTING an event (a meeting-notes provider's full transcript must not
 * bounce with a 413); this is about what is worth storing and shipping as
 * one turn message, which `TURN_MESSAGE_MAX_LENGTH` bounds at 100 K chars
 * everywhere else. Providers put the summary first and the bulk (transcripts,
 * raw records) last, so clipping the tail keeps the part the agent acts on.
 */
export const MAX_WEBHOOK_PAYLOAD_CHARS = 80_000;

export const WEBHOOK_NAME_MAX_LENGTH = 100;
export const WEBHOOK_INSTRUCTIONS_MAX_LENGTH = 10_000;

/**
 * One run's outcome bookkeeping, shared by the two places a webhook run can
 * end: the settle chain (turn-service) after a real run, and the receive door
 * when door 1 refuses the turn at creation (no model key) so it never
 * settles. One definition, so the two can never disagree on when a webhook
 * turns itself off. `null` = nothing to book (a human stopped the run).
 */
export const webhookRunOutcome = (
  status: "done" | "failed" | "aborted",
  priorFailures: number,
): {
  lastOutcome: WebhookOutcome;
  consecutiveFailures: number;
  enabled?: false;
  disabledReason?: WebhookDisabledReason;
} | null => {
  if (status === "aborted") return null;
  if (status === "done") return { lastOutcome: "ok", consecutiveFailures: 0 };
  const consecutiveFailures = priorFailures + 1;
  return {
    lastOutcome: "failed",
    consecutiveFailures,
    ...(consecutiveFailures >= WEBHOOK_FAILURE_DISABLE_THRESHOLD && {
      enabled: false,
      disabledReason: "failures",
    }),
  };
};

const fields = {
  name: z.string().trim().min(1).max(WEBHOOK_NAME_MAX_LENGTH),
  instructions: z.string().trim().min(1).max(WEBHOOK_INSTRUCTIONS_MAX_LENGTH),
};

/** POST /v1/agents/:agentId/webhooks */
export const createWebhookSchema = z.object(fields).strict();
export type WebhookInput = z.infer<typeof createWebhookSchema>;

/** The editable fields, shared by the dashboard's PATCH and the agent's
 * update_webhook, so the two doors accept exactly the same values. */
const updateFields = {
  name: fields.name.optional(),
  instructions: fields.instructions.optional(),
  enabled: z.boolean().optional(),
};

const NOTHING_TO_UPDATE =
  "Nothing to update: pass name, instructions, or enabled";
const hasChange = (v: Partial<Record<keyof typeof updateFields, unknown>>) =>
  v.name !== undefined ||
  v.instructions !== undefined ||
  v.enabled !== undefined;

/** PATCH /v1/agents/:agentId/webhooks/:webhookId — partial; `enabled` is the
 * pause switch (re-enabling clears an auto-disable reason). */
export const updateWebhookSchema = z
  .object(updateFields)
  .strict()
  .refine(hasChange, NOTHING_TO_UPDATE);
export type WebhookUpdate = z.infer<typeof updateWebhookSchema>;

// ── The agent's webhook tools (list_webhooks, webhook_runs, update_webhook) ──
// The agent manages EXISTING webhooks only: it never mints one (that would
// hand it a public URL it could leak) and never sees a URL or token.

const webhookIdField = z.string().trim().min(1).max(100);

/** list_webhooks takes no arguments. */
export const listWebhooksArgsSchema = z.object({}).strict();

/** Most past runs one webhook_runs call returns, and the default. */
const WEBHOOK_RUNS_TOOL_MAX = 10;
export const WEBHOOK_RUNS_TOOL_DEFAULT = 5;

/** webhook_runs */
export const webhookRunsArgsSchema = z
  .object({
    webhookId: webhookIdField,
    limit: z.number().int().min(1).max(WEBHOOK_RUNS_TOOL_MAX).optional(),
  })
  .strict();

/** update_webhook: the dashboard's PATCH fields, by id. Also the frozen
 * payload of the approval it holds, re-validated when a person approves. */
export const updateWebhookArgsSchema = z
  .object({ webhookId: webhookIdField, ...updateFields })
  .strict()
  .refine(hasChange, NOTHING_TO_UPDATE);
export type WebhookUpdateArgs = z.infer<typeof updateWebhookArgsSchema>;

/** The action-approval action an agent's update_webhook holds under. */
export const WEBHOOK_UPDATE_ACTION = "webhook.update";
