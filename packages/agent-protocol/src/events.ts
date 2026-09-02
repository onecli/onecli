import { z } from "zod";

/**
 * The canonical agent-event vocabulary (plans/hosted-agents-v2.md §5) — the
 * ONLY event language anything above a harness adapter ever sees. Adapters
 * translate vendor streams into these; the control plane persists them; the
 * UI renders them. No vendor concept may appear here (invariant 9).
 *
 * Events are pure payloads: turn/session attribution rides the transport
 * envelope, and the persistence `seq` is assigned control-plane-side (step 4).
 */

export const turnStartedEventSchema = z.object({
  type: z.literal("turn.started"),
});

export const textDeltaEventSchema = z.object({
  type: z.literal("text.delta"),
  text: z.string(),
});

export const thinkingDeltaEventSchema = z.object({
  type: z.literal("thinking.delta"),
  text: z.string(),
});

/**
 * The turn's answer, whole, emitted once just before the terminal event.
 *
 * The delta law (§3.17) makes `text.delta` ephemeral — thousands of rows to
 * reconstruct one paragraph is not a transcript. But a transcript without the
 * answer is not one either: a reader who refreshes would get their own
 * questions and the tool calls back, and none of the replies.
 *
 * So the supervisor — which is the only party that sees the whole stream —
 * accumulates the deltas it forwarded and sends them once, as this. One
 * bounded row per turn, holding exactly the text the user watched arrive.
 * Partial answers count: an aborted or failed turn emits what it managed to
 * say before it stopped.
 *
 * **READER RULE — this REPLACES the turn's delta text, it never appends to
 * it.** Live tails receive both (everything published reaches them), so a
 * reader that appends renders the whole answer twice. Replacing is also what
 * repairs a reader who joined mid-turn: history carries no deltas, so the
 * deltas it missed arrive only here. Same rule for every consumer — the
 * dashboard, and Slack in step 6.
 *
 * **SECURITY — this is UNTRUSTED CONTENT, and now it is durable.** It is
 * model output from a sandbox that reads the open internet, so a page the
 * agent visits can tell it what to say. Streamed-and-forgotten text was a
 * transient problem; a stored row is served to every later reader of that
 * conversation. Render it as TEXT. Any consumer that turns it into markup —
 * `dangerouslySetInnerHTML`, a markdown renderer with raw HTML enabled, a
 * Slack block built by string interpolation — turns prompt injection into
 * stored XSS against the operator who reads the transcript. The same applies
 * to `tool.finished.output`, which has been durable since step 4.
 */
export const textEventSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const toolStartedEventSchema = z.object({
  type: z.literal("tool.started"),
  callId: z.string(),
  name: z.string(),
});

export const toolFinishedEventSchema = z.object({
  type: z.literal("tool.finished"),
  callId: z.string(),
  name: z.string(),
  output: z.string(),
  isError: z.boolean().optional(),
});

/**
 * Reserved for gateway-held approvals surfacing in the conversation (step 4+).
 * No step-2 adapter emits it: local tool permissions are auto-allowed (§3.1 —
 * gating lives at the network boundary, not inside the sandbox).
 */
export const approvalPendingEventSchema = z.object({
  type: z.literal("approval.pending"),
  description: z.string(),
});

export const turnUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
});
export type TurnUsage = z.infer<typeof turnUsageSchema>;

export const turnDoneEventSchema = z.object({
  type: z.literal("turn.done"),
  usage: turnUsageSchema.optional(),
});

/** A failed turn ends with `error` INSTEAD of `turn.done`, never both. */
export const errorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  code: z.string().optional(),
});

/**
 * Something the reader should know that did NOT stop the turn.
 *
 * Deliberately distinct from `error`, which is terminal by definition — both
 * `isTerminalEvent` here and the dashboard's fold treat it as the end of the
 * turn. A degraded preference ("that model isn't available, running the
 * default") has to travel alongside a turn that then succeeds, so it needs a
 * channel that carries no ending.
 *
 * SECURITY: like `text`, this is authored inside the sandbox and is therefore
 * untrusted. Render as TEXT.
 */
export const noticeEventSchema = z.object({
  type: z.literal("notice"),
  level: z.enum(["info", "warn"]),
  text: z.string(),
});

/**
 * A steered follow-up message was CONSUMED by this turn — the adapter
 * confirmed the harness injected it into the live run. Emitted just before
 * the terminal event, one per confirmed follow-up. `followUpId` is the
 * opaque correlation id the steer carried in; the supervisor folds these
 * into `turn.result.followUps`, which is how the control plane settles the
 * follow-up row `joined`. A control-plane state transition, not transcript
 * content — the settled row is the record, so this is never persisted.
 */
export const messageJoinedEventSchema = z.object({
  type: z.literal("message.joined"),
  followUpId: z.string(),
});

export const agentEventSchema = z.discriminatedUnion("type", [
  turnStartedEventSchema,
  textDeltaEventSchema,
  textEventSchema,
  thinkingDeltaEventSchema,
  toolStartedEventSchema,
  toolFinishedEventSchema,
  approvalPendingEventSchema,
  noticeEventSchema,
  messageJoinedEventSchema,
  turnDoneEventSchema,
  errorEventSchema,
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent["type"];

/** The two events that legally terminate a turn's stream. */
export const isTerminalEvent = (
  event: AgentEvent,
): event is Extract<AgentEvent, { type: "turn.done" | "error" }> =>
  event.type === "turn.done" || event.type === "error";
