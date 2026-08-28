/**
 * The shared failure-classification vocabulary for the sandbox lifecycle.
 *
 * These are the machine-readable code STRINGS that ride the wires — the
 * supervisor's `turn.result.errorCode`, the runner's `turn.finished.errorCode`
 * and `sandbox.status.reasonCode`. The user-facing COPY for each code lives in
 * the control plane only (`packages/api/src/validations/conversation.ts`),
 * which maps known codes through an allowlist and treats unknown ones as
 * absent — so a peer speaking a newer vocabulary degrades to today's raw
 * behavior instead of breaking. For the same reason the wire fields themselves
 * are open bounded strings, never enums: one novel code must not invalidate a
 * whole event batch or drop a must-deliver terminal frame.
 */

/**
 * How a turn's failure relates to the harness's life. Attached by the
 * supervisor (and by the runner's synthetic no-channel failures) when the
 * harness actually died — or, the one live-harness exception, when the model
 * provider refused the request. Every other ordinary turn failure on a live
 * harness carries no code and keeps its raw error.
 *
 * - `agent_restarted`: the harness died AFTER the turn's stream opened —
 *   observable work may exist, so the failure must stay visible.
 * - `agent_start_failed`: the harness died BEFORE the stream opened — nothing
 *   observable happened, which is what makes the control plane's invisible
 *   one-shot revival safe.
 * - `model_provider_error`: the harness lived but its model provider refused
 *   the request (usage limit, exhausted credits, invalid key). Classified by
 *   the supervisor from the harness's terminal error; canonical copy replaces
 *   the raw provider response on every chat surface — the raw text stays
 *   operator material (the control plane's server log and the stored
 *   transcript events).
 * - `trial_credit_exhausted`: the harness lived but the GATEWAY paused the
 *   platform's trial-credit key at its spend cap (the `budget_exceeded` 403
 *   for the `platform:anthropic` credential). A sibling of
 *   `model_provider_error` with a sharper fix — there is no user key to
 *   check; the person needs to CONNECT one — so it earns its own code and
 *   copy. Classified by the supervisor from the gateway's coded JSON body,
 *   never from prose.
 * - `harness_busy`: the harness refused to take the turn's message because
 *   its session was still executing an earlier, platform-abandoned run — and
 *   the adapter's self-heal (cancel the orphan, resend with backoff) could
 *   not free it. Minted by the ADAPTER on its terminal error event (the
 *   vendor's refusal wording never crosses the adapter boundary) and carried
 *   to `turn.result.errorCode` by the supervisor. The raw refusal rides
 *   beside it as `error` so an old control plane that ignores the code still
 *   stores visible text instead of a silent NULL.
 */
export const TURN_FAILURE_CODES = {
  agentRestarted: "agent_restarted",
  agentStartFailed: "agent_start_failed",
  modelProviderError: "model_provider_error",
  trialCreditExhausted: "trial_credit_exhausted",
  harnessBusy: "harness_busy",
} as const;
export type TurnFailureCode =
  (typeof TURN_FAILURE_CODES)[keyof typeof TURN_FAILURE_CODES];

/**
 * Why a sandbox start failed, classified by the runner (the only party that
 * saw the underlying error). `start_failed` is the deliberate catch-all — the
 * control plane treats any unknown value exactly like it.
 */
export const SANDBOX_START_FAILURE_REASONS = [
  "image_unavailable",
  "at_capacity",
  "start_failed",
] as const;
export type SandboxStartFailureReason =
  (typeof SANDBOX_START_FAILURE_REASONS)[number];
