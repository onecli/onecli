import type { TurnEvent } from "@/lib/api/types";

/**
 * Incremental SSE parsing as a pure reducer, so chunk-boundary behavior is
 * testable by feeding one character at a time.
 *
 * Two deliberate deviations from the WHATWG algorithm: `id` does not persist
 * across frames (our resume cursor is the highest `seq` over parsed events —
 * the `Last-Event-ID` header it would feed is blocked by CORS anyway), and
 * lone-CR line terminators are unsupported (the server writes LF).
 */

export interface SseFrame {
  /** The frame's `id:` field when present. Kept for tests/debugging only. */
  id?: string;
  /** The `event:` field; the SSE default is "message" when absent. */
  event: string;
  /** All `data:` lines of the frame, joined with "\n". */
  data: string;
}

export interface SseParserState {
  /** Unterminated tail of the last chunk (may end mid-line or in a bare CR). */
  buffer: string;
  /** Fields of the frame being accumulated (between blank lines). */
  id?: string;
  event?: string;
  data: string[];
}

export const initialSseState: SseParserState = { buffer: "", data: [] };

/** Feed one decoded chunk; get completed frames and the state for the next. */
export const pushSseChunk = (
  state: SseParserState,
  chunk: string,
): { state: SseParserState; frames: SseFrame[] } => {
  const frames: SseFrame[] = [];
  let { id, event } = state;
  let data = state.data;

  // Split on LF and strip a trailing CR per line: handles LF and CRLF, and a
  // CRLF split across chunks simply keeps its "\r" buffered until the "\n".
  const lines = (state.buffer + chunk).split("\n");
  const buffer = lines.pop() ?? "";

  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (line === "") {
      // Blank line = dispatch. A frame with no data lines dispatches nothing
      // (spec behavior — what makes ": keep-alive\n\n" invisible).
      if (data.length > 0) {
        frames.push({
          ...(id !== undefined && { id }),
          event: event ?? "message",
          data: data.join("\n"),
        });
      }
      id = undefined;
      event = undefined;
      data = [];
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === 0) continue; // comment line

    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // exactly one space

    if (field === "data") data = [...data, value];
    else if (field === "event") event = value;
    else if (field === "id") id = value;
    // "retry" and unknown fields: ignored by design.
  }

  return { state: { buffer, id, event, data }, frames };
};

/**
 * Decode a frame into a TurnEvent, or null for anything else — an unknown
 * event name, malformed JSON, or a payload missing its shape. Null rather
 * than throw: a future server event must degrade to "ignored", never to a
 * dead transcript. The `seq` guard is concrete, not ceremony — a seq-less
 * object would enter `mergeEvents`' Map keyed `undefined` and sort as NaN.
 */
export const parseTranscriptFrame = (frame: SseFrame): TurnEvent | null => {
  if (frame.event !== "transcript") return null;
  try {
    const parsed: unknown = JSON.parse(frame.data);
    if (typeof parsed !== "object" || parsed === null) return null;
    const e = parsed as Record<string, unknown>;
    if (typeof e.seq !== "number" || !Number.isFinite(e.seq)) return null;
    if (typeof e.turnId !== "string" || typeof e.type !== "string") return null;
    if (typeof e.payload !== "object" || e.payload === null) return null;
    return e as unknown as TurnEvent;
  } catch {
    return null;
  }
};
