import type { ApiEvent } from "@1jehuang/jcode-sdk";
import { TURN_FAILURE_CODES, type HarnessEvent } from "@onecli/agent-protocol";

/**
 * jcode's "this turn produced no visible answer" signal, translated into the
 * protocol's `turn.unanswered`.
 *
 * When the model ends a turn with no text and no tool call, jcode's turn loop
 * (verified against the pinned v1.0.0-preview.136 source,
 * `agent/turn_streaming_mpsc.rs` + `agent/response_recovery.rs`) first spends
 * its own recovery (a continuation after an empty post-tool response, a
 * reconsideration for some models), and only when the turn still ends empty
 * does it broadcast a `provider_guardrail` event. The bridge
 * (`harness-api-server/src/translate.rs`) forwards that as a `turn_stopped`
 * frame with `reason: "provider_guardrail"`, the provider's raw
 * `provider_stop_reason`, and jcode's own explanation in `message`, ahead of
 * the turn's ordinary `turn_done`. The run itself ends cleanly, so without
 * this translation the turn closes as a normal reply with no words in it.
 *
 * Despite the name, jcode emits that same reason for BOTH outcomes, so the
 * split happens here, on the provider's stop reason, with jcode's own rule
 * (`is_guardrail_stop_reason`): a safety stop is a refusal, anything else
 * (`end_turn`, `stop`, absent) is an empty response.
 *
 * One more case shares the frame and is NOT this: jcode raises it for a
 * safety stop on the stop reason alone, so a reply cut short AFTER real
 * words gets it too. Those words are an answer, so the adapter's live loop
 * (which sees the words; this pure reader does not) drops the frame when
 * any stand since the last tool call.
 *
 * Every other `turn_stopped` reason is ignored on purpose. `interrupted` is
 * a Stop the supervisor already owns, and `failure` / `crash` /
 * `limit_reached` precede an `error` or a truncated answer that keeps its
 * own path today: this module adds exactly one outcome and changes none.
 */

/** jcode's guardrail stop reasons, as `is_guardrail_stop_reason` defines
 * them: the exact provider values plus the two families matched by name. */
const GUARDRAIL_STOP_REASONS: ReadonlySet<string> = new Set([
  "refusal",
  "content_filter",
  "safety",
]);
const GUARDRAIL_STOP_FAMILIES = ["guardrail", "policy_violation"] as const;

const isGuardrailStopReason = (stopReason: string | undefined): boolean => {
  const reason = stopReason?.trim().toLowerCase();
  if (!reason) return false;
  return (
    GUARDRAIL_STOP_REASONS.has(reason) ||
    GUARDRAIL_STOP_FAMILIES.some((family) => reason.includes(family))
  );
};

/** The fields of the SDK's `turn_stopped` frame this module reads. */
export type JcodeTurnStopped = Pick<
  Extract<ApiEvent, { ev: "turn_stopped" }>,
  "reason" | "message" | "provider_stop_reason"
>;

/** The ONE reason jcode uses for a turn that ended with nothing visible. */
const NO_VISIBLE_OUTPUT_REASON = "provider_guardrail";

/** Bounds jcode's explanation before it rides out as the raw error: it is
 * operator material, a sentence or two, and the supervisor bounds it again. */
const MAX_MESSAGE_CHARS = 1_000;

/**
 * The protocol event for a `turn_stopped` frame, or `null` when the frame is
 * not the no-visible-output signal. The provider's stop reason is appended
 * to the message when jcode's own sentence does not already carry it, so an
 * operator reading the raw error can tell a `refusal` from a
 * `content_filter`.
 */
export const readJcodeTurnStopped = (
  frame: JcodeTurnStopped,
): Extract<HarnessEvent, { type: "turn.unanswered" }> | null => {
  if (frame.reason !== NO_VISIBLE_OUTPUT_REASON) return null;
  const stopReason = frame.provider_stop_reason?.trim() || undefined;
  const base =
    frame.message.trim() || "The model ended its turn without any output.";
  const message =
    stopReason && !base.includes(stopReason)
      ? `${base} (stop_reason: ${stopReason})`
      : base;
  return {
    type: "turn.unanswered",
    code: isGuardrailStopReason(stopReason)
      ? TURN_FAILURE_CODES.modelRefused
      : TURN_FAILURE_CODES.modelEmptyResponse,
    message: message.slice(0, MAX_MESSAGE_CHARS),
  };
};
