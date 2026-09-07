import {
  activityForReasoning,
  activityForTool,
} from "@onecli/agent-protocol/activity";
import type { TurnEvent } from "@/lib/api/types";

/**
 * Turning a flat event log into something a person can read.
 *
 * Pure on purpose: `apps/web` has no component-test harness, so everything
 * with a decision in it lives here where it can be tested as ordinary
 * TypeScript, and the components stay thin enough to verify by looking.
 */

export interface ToolCall {
  callId: string;
  name: string;
  /** Absent until the tool reports back — that is what "running" looks like. */
  output?: string;
  isError?: boolean;
}

/**
 * One entry in the turn's live work log, in true stream order: the agent
 * narrates ("Let me check the logs."), a tool runs, it narrates again. The
 * SUPERVISOR's segment rule, mirrored (supervisor.ts, 2026-08-31): a tool
 * call is the one structural break the model cannot write across, so it is
 * the one boundary that closes a narration segment. Thinking is NOT a
 * boundary — reasoning interleaves inside one message, and cutting there
 * would publish half a sentence.
 *
 * Tool items share object identity with `RenderedTurn.tools`, so a
 * `tool.finished` folding onto its start updates both views at once.
 *
 * SECURITY: narration text is UNTRUSTED model output from a sandbox that
 * reads the open internet. It is PROGRESS, not the answer — render it as
 * TEXT, never markdown (the answer path stays the only markdown surface).
 */
export type WorkItem =
  | { kind: "tool"; tool: ToolCall }
  | { kind: "narration"; text: string };

/** One turn as the reader sees it: what was asked, what happened, what came back. */
export interface RenderedTurn {
  turnId: string;
  /**
   * The agent's ANSWER — the durable `text` event, nothing else. Empty while
   * the turn still runs: mid-turn deltas build `liveText`/`work`, never this,
   * so a consumer of `text` can never mistake narration for the answer.
   */
  text: string;
  tools: ToolCall[];
  /**
   * The work as it happened, chronologically: closed narration segments
   * interleaved with the tool calls that closed them. Live-tail only in
   * practice — history carries no deltas, so a reader who joins late gets
   * tools without narration, which is exactly what the transcript records.
   */
  work: WorkItem[];
  /**
   * The narration segment CURRENTLY streaming — everything said since the
   * last tool call. Rendered as the transient tail while the turn runs, and
   * cleared the moment the durable answer arrives (the answer replaces the
   * whole delta view, per the reader rule on `textEventSchema`).
   */
  liveText: string;
  /**
   * What the agent is doing RIGHT NOW, in a few words — the live loader
   * caption ("Reading a file", "Architecting the narrative arc").
   *
   * Derived from the ephemeral stream, never from history: `thinking.delta`
   * says it in the agent's own words, `tool.started` says it by name. It is
   * REPLACED as work moves and dropped the moment the turn ends, because it
   * describes the present — a finished turn has no current activity, and a
   * reader who joins late gets the answer, not a stale caption.
   *
   * UNTRUSTED: model text from a sandbox. Bounded and control-stripped at the
   * source (`activityForReasoning`), and rendered as TEXT, never markup.
   */
  activity?: string;
  /** Set when the turn ended badly — rendered instead of a silent stop. */
  error?: string;
  /**
   * Non-fatal warnings about the run ("that model isn't available, so this is
   * running the default"). Distinct from `error` because they do NOT end the
   * turn — the agent goes on to answer, and both belong on screen.
   */
  notices: string[];
  /** True once a terminal event landed, so the composer can re-enable. */
  ended: boolean;
}

const str = (payload: Record<string, unknown>, key: string): string =>
  typeof payload[key] === "string" ? (payload[key] as string) : "";

/**
 * Fold the transcript into per-turn views.
 *
 * The one rule worth stating: a `text` event REPLACES whatever the deltas
 * built, it never appends. Live tails receive both, so appending renders the
 * answer twice — and replacing is also what repairs a reader who joined
 * mid-turn, because history carries no deltas at all (see the schema note on
 * `textEventSchema`).
 */
export const foldTranscript = (events: TurnEvent[]): RenderedTurn[] => {
  const order: string[] = [];
  const byTurn = new Map<string, RenderedTurn>();

  const turnFor = (turnId: string): RenderedTurn => {
    const existing = byTurn.get(turnId);
    if (existing) return existing;
    const created: RenderedTurn = {
      turnId,
      text: "",
      work: [],
      liveText: "",
      notices: [],
      tools: [],
      ended: false,
    };
    byTurn.set(turnId, created);
    order.push(turnId);
    return created;
  };

  for (const event of events) {
    const turn = turnFor(event.turnId);
    switch (event.type) {
      case "text.delta":
        // Mid-turn narration builds the LIVE TAIL, never the answer: the
        // supervisor decided the answer is the last message, so until the
        // durable `text` lands, everything streamed is provisional.
        turn.liveText += str(event.payload, "text");
        break;
      case "text":
        // REPLACE. See above — appending double-renders every answer. The
        // live tail dies with it: the answer IS that tail, coalesced (or,
        // on a turn that ended mid-tool, the last completed segment).
        turn.text = str(event.payload, "text");
        turn.liveText = "";
        break;
      case "tool.started": {
        // The tool call CLOSES the current narration segment (the
        // supervisor's segment rule, mirrored). Blank segments are never
        // pushed — back-to-back tools must not litter the log.
        if (turn.liveText.trim()) {
          turn.work.push({ kind: "narration", text: turn.liveText });
        }
        turn.liveText = "";
        const tool: ToolCall = {
          callId: str(event.payload, "callId"),
          name: str(event.payload, "name"),
        };
        turn.tools.push(tool);
        // Same object in both views: the finish below mutates it once.
        turn.work.push({ kind: "tool", tool });
        // A started tool IS the current activity, and it outranks whatever
        // the agent was thinking a moment ago: the reasoning explains the
        // plan, the tool call is the plan happening.
        turn.activity = activityForTool(str(event.payload, "name"));
        break;
      }
      case "tool.finished": {
        const callId = str(event.payload, "callId");
        const started = turn.tools.find((t) => t.callId === callId);
        const finished = {
          output: str(event.payload, "output"),
          ...(event.payload.isError === true && { isError: true }),
        };
        if (started) Object.assign(started, finished);
        // A finish with no start still happened — show it rather than drop it.
        else {
          const orphan: ToolCall = {
            callId,
            name: str(event.payload, "name"),
            ...finished,
          };
          turn.tools.push(orphan);
          turn.work.push({ kind: "tool", tool: orphan });
        }
        break;
      }
      case "notice":
        // Deliberately does NOT set `ended`. This is the whole reason it is
        // not an `error` event: a degraded preference travels alongside a turn
        // that then succeeds, and `error` is terminal by definition here and
        // in `isTerminalEvent`.
        turn.notices.push(str(event.payload, "text"));
        break;
      case "error":
        turn.error = str(event.payload, "message");
        turn.ended = true;
        turn.activity = undefined;
        break;
      case "turn.done":
        turn.ended = true;
        // The turn is over: there is no current activity, and a caption left
        // standing would describe work that already finished.
        turn.activity = undefined;
        break;
      case "thinking.delta": {
        // The agent saying what it is about to do, in its own words — the
        // line that makes the loader feel alive rather than generic. Only
        // the first line survives (see `activityForReasoning`); null means
        // the block said nothing worth showing, so the previous caption
        // stands rather than blanking the row.
        const said = activityForReasoning(str(event.payload, "text"));
        if (said) turn.activity = said;
        break;
      }
      default:
        // `turn.started`, `approval.pending` — nothing to fold here.
        // Approvals render from the live approvals API, which carries the
        // decision surface the transcript does not.
        break;
    }
  }

  return order.map((id) => byTurn.get(id)!);
};

/**
 * Merge a page of events into what we already hold, by `seq`.
 *
 * The stream replays history before it tails, and a reconnect replays from a
 * cursor, so the SAME event legitimately arrives twice. Keying by `seq` — which
 * is unique per conversation and assigned in commit order — makes that
 * idempotent instead of duplicating the transcript on every reconnect.
 */
export const mergeEvents = (
  held: TurnEvent[],
  incoming: TurnEvent[],
): TurnEvent[] => {
  if (incoming.length === 0) return held;

  // The common case — a live tail appending strictly past what we hold — is
  // O(incoming). The Map rebuild below only runs on genuine overlap (a
  // reconnect replaying from the cursor).
  const lastHeld = held.at(-1)?.seq ?? -Infinity;
  const appendsInOrder = incoming.every(
    (event, i) => event.seq > (i === 0 ? lastHeld : incoming[i - 1]!.seq),
  );
  if (appendsInOrder) return [...held, ...incoming];

  const bySeq = new Map(held.map((e) => [e.seq, e]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
};

/** The cursor to resume a stream from: the highest `seq` we hold. */
export const highestSeq = (events: TurnEvent[]): number =>
  events.reduce((max, e) => (e.seq > max ? e.seq : max), 0);
