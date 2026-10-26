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

/**
 * A slice of the agent's prose as it is written. Attribution rides the
 * envelope: a delta that answers a mid-run follow-up is sent under THAT
 * follow-up's turn id, so a live reader sees the reply grow
 * under the message it answers, exactly where the settled `text` row lands.
 * Deltas are live-only (never persisted); the durable `text` follows them.
 */
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

/**
 * A tool call's end. `input` is the arguments the model sent (the SQL, the
 * search query, the shell command), as the harness streamed them: raw text,
 * usually JSON. Optional because not every harness exposes it and a reader
 * written before it existed must keep working. It is what makes a transcript
 * explain a wrong answer ("it queried the wrong table"), so it is durable
 * alongside `output`, and it is just as UNTRUSTED: model-authored, rendered
 * as text only.
 *
 * Two outcomes, deliberately separate. `isError` means the TOOL failed: it
 * could not do what was asked (bad arguments, an unknown id, a refusal).
 * `exitCode` is a shell command's own status, present only when the harness
 * reported a non-zero one: the command ran, and exiting 1 is often the
 * answer (`grep` found nothing), not a failure. An adapter fills it from its
 * vendor's output format and strips that format from `output`, so no reader
 * ever parses vendor text, and the status survives any truncation of the
 * output on the way.
 */
export const toolFinishedEventSchema = z.object({
  type: z.literal("tool.finished"),
  callId: z.string(),
  name: z.string(),
  input: z.string().optional(),
  output: z.string(),
  isError: z.boolean().optional(),
  exitCode: z.number().int().optional(),
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
 * The control plane's stamp on a notice that records a message THIS agent
 * sent to a peer agent (agent-to-agent, PR 5b): the sender's own words, in
 * the structured shape the dashboard's pair-conversation view reads as this
 * agent's bubble - never parsed back out of `text`. Written by the control
 * plane only (the sender's record turn); a sandbox never authors it, and a
 * reader takes it only from a `notice`. Kept beside the notice schema so the
 * writer (api) and the reader (web) agree on one shape; the notice schema
 * itself stays canonical and does not carry it, because a stamp is the
 * platform's annotation on the event, not part of the sandbox wire.
 */
export const peerMessageStampSchema = z.object({
  /** The peer agent's id. */
  to: z.string(),
  text: z.string(),
  /** This message OPENED a peer task: a person asked for it, and the
   * agent will report back to that person (the pair view marks the bubble).
   * Absent on every agent-driven message. */
  opensTask: z.literal(true).optional(),
});
export type PeerMessageStamp = z.infer<typeof peerMessageStampSchema>;

/** Read the stamp off a notice payload; `null` when absent or malformed. */
export const readPeerMessageStamp = (
  payload: Record<string, unknown>,
): PeerMessageStamp | null => {
  const parsed = peerMessageStampSchema.safeParse(payload.peerMessage);
  return parsed.success ? parsed.data : null;
};

/**
 * Why a peer task ended. `reported` is the one the agent chose
 * (`complete_task`); the rest are the platform's backstops, each of which
 * still hands the person a close line in their conversation.
 */
export const PEER_TASK_OUTCOMES = [
  "reported",
  "budget",
  "expired",
  "blocked",
  "removed",
  "undeliverable",
] as const;
export type PeerTaskOutcome = (typeof PEER_TASK_OUTCOMES)[number];

/**
 * The control plane's stamp on a notice that records a peer task CLOSING
 * on the pair conversation (the PR after 5b): the pair view shows the
 * dialog's end ("Reported back", or why it ended without a report). Same
 * posture as `peerMessage`: platform-authored, read only off a `notice`,
 * stripped at the wire when a sandbox forges it.
 */
export const peerTaskStampSchema = z.object({
  outcome: z.enum(PEER_TASK_OUTCOMES),
});
export type PeerTaskStamp = z.infer<typeof peerTaskStampSchema>;

/** Read the stamp off a notice payload; `null` when absent or malformed. */
export const readPeerTaskStamp = (
  payload: Record<string, unknown>,
): PeerTaskStamp | null => {
  const parsed = peerTaskStampSchema.safeParse(payload.peerTask);
  return parsed.success ? parsed.data : null;
};

/** How a `request_human_takeover` ask ended: still open, handed back (the
 * person pressed Stop), the controller went quiet, or nobody came within a
 * day. */
export const DESKTOP_REQUEST_OUTCOMES = [
  "pending",
  "done",
  "timeout",
  "expired",
] as const;
export type DesktopRequestOutcome = (typeof DESKTOP_REQUEST_OUTCOMES)[number];

/**
 * The control plane's stamp on a notice about a desktop takeover ask: the
 * ask's id and where it stands. The web renders the `pending` notice as
 * the in-chat card (an Open computer action deep-linked to the ask); the
 * settled ones read as plain notices. Same posture as `peerMessage`:
 * platform-authored, read only off a `notice`, stripped at the wire when a
 * sandbox forges it (the notice schema carries no such key).
 */
export const desktopRequestStampSchema = z.object({
  id: z.string(),
  outcome: z.enum(DESKTOP_REQUEST_OUTCOMES),
});
export type DesktopRequestStamp = z.infer<typeof desktopRequestStampSchema>;

/** Read the stamp off a notice payload; `null` when absent or malformed. */
export const readDesktopRequestStamp = (
  payload: Record<string, unknown>,
): DesktopRequestStamp | null => {
  const parsed = desktopRequestStampSchema.safeParse(payload.desktopRequest);
  return parsed.success ? parsed.data : null;
};

/**
 * The control plane's stamp on the "Replaced by your message" notice: the
 * held gateway approvals a person's newer message withdrew. The web settles
 * those cards as replaced instead of "Decided elsewhere". Same posture as
 * `peerMessage`: platform-authored, read only off a `notice`, stripped at
 * the wire when a sandbox forges it (the notice schema carries no such key).
 */
export const supersededApprovalsStampSchema = z.array(z.string()).min(1);

/** Read the withdrawn approval ids off a notice payload; `[]` when absent
 * or malformed. */
export const readSupersededApprovalsStamp = (
  payload: Record<string, unknown>,
): string[] => {
  const parsed = supersededApprovalsStampSchema.safeParse(
    payload.supersededApprovalIds,
  );
  return parsed.success ? parsed.data : [];
};

/**
 * A steered follow-up message was CONSUMED by this turn — the adapter
 * confirmed the harness injected it into the live run. Emitted the moment the
 * harness confirms it (mid-run, on a runtime with the live pickup signal) or
 * just before the terminal event (a runtime that can only tell at the end),
 * one per confirmed follow-up. `followUpId` is the opaque correlation id the
 * steer carried in. The control plane settles the follow-up row `joined` as
 * soon as the event arrives; the supervisor also folds these into
 * `turn.result.followUps`, the backstop that settles any join the live stream
 * never carried. A control-plane state transition, not transcript content:
 * the settled row is the record, so this is never persisted.
 */
export const messageJoinedEventSchema = z.object({
  type: z.literal("message.joined"),
  followUpId: z.string(),
});

/**
 * SEND NOW's outcome, sent under the waiting FOLLOW-UP's own
 * turn id: the person asked the agent to read that message now, and this is
 * the honest answer. `moved` means the harness moved the tool the run was
 * waiting on (`toolName`) to the background, so the run reaches its next
 * safe point and reads the message within moments (its `message.joined`
 * follows). `moved: false` means there was nothing to move (no tool was
 * running, or the harness cannot say what it moved), and the message is
 * read at the run's next safe point as before. Live-only, like
 * `message.joined`: the row's own status is the durable record, and a
 * reader who arrives later has nothing left to be told.
 */
export const messageSentNowEventSchema = z.object({
  type: z.literal("message.sent_now"),
  moved: z.boolean(),
  toolName: z.string().optional(),
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
  messageSentNowEventSchema,
  turnDoneEventSchema,
  errorEventSchema,
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent["type"];

/** The two events that legally terminate a turn's stream. Generic so it
 * narrows the harness-side vocabulary (`HarnessEvent`) as well as this one. */
export const isTerminalEvent = <E extends { type: string }>(
  event: E,
): event is Extract<E, { type: "turn.done" | "error" }> =>
  event.type === "turn.done" || event.type === "error";
