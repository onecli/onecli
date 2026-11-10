/**
 * The pacing behind the chat's smooth reveal, pure so every decision is
 * testable without a browser: given what has arrived and when, how much of
 * it should be on screen at this frame.
 *
 * The problem it solves: streamed text reaches the browser in network
 * batches (typically one every ~420ms, ~135 characters at a
 * time), and painting each batch the moment it lands reads as chunks
 * jumping in. A reader wants a steady flow. So the screen trails the
 * network slightly and spends each batch over about one batch interval.
 *
 * The rules, each tuned on recorded arrival times (see the tests):
 *
 * - LINEAR per batch: when a batch lands, the rate is fixed at
 *   backlog / (1.6 x the average gap between batches), at least one unit per
 *   frame. Re-deriving the rate every frame as a share of what is left
 *   drains exponentially and leaves a long tail (it finished up to 1.3s
 *   after the data did). 1.6x stretches each batch nearly to the next one,
 *   so the flow rarely pauses between batches.
 * - CATCH UP when the text is final: the rest is shown within 250ms. The
 *   reader never waits on an animation for words that have all arrived.
 * - FLOW IN an answer that arrives WHOLE in front of the reader (one final
 *   text and no deltas before it, which is how an answer after tool calls
 *   usually lands): at a reading pace, over at most WHOLE_MAX_MS, rather
 *   than popping in as one block a moment after the work finished.
 * - WORDS, not characters: the reveal only ever stops at a word boundary
 *   (or a grapheme, for scripts that do not separate words with spaces), so
 *   a half-typed word never flashes.
 * - SNAP when the text is not an extension of what is shown (a correction,
 *   or the final answer differing from the draft): the new text appears at
 *   once, nothing is animated backwards.
 */

/** How long the final stretch may take once nothing more is coming. */
export const CATCH_UP_MS = 250;

/** An answer that arrives whole flows in at about this many characters per
 *  millisecond (a brisk stream: ~400 a second)... */
export const WHOLE_CHARS_PER_MS = 0.4;

/** ...and never takes longer than this, however long it is: the words are
 *  all here, the reader must not wait on the animation. */
export const WHOLE_MAX_MS = 1_800;

/** Each batch is spread over this many average gaps. */
export const STRETCH = 1.6;

/** Before two batches have arrived there is no gap to average: a typical
 *  median between network reads. */
export const INITIAL_GAP_MS = 420;

/** A gap longer than this is a pause in the stream (a tool running, the
 *  model thinking), not its cadence, and must not slow the next reveal. */
const MAX_GAP_MS = 1_200;

export interface Pacer {
  /** Characters of `target` currently shown. */
  shown: number;
  /** Characters per millisecond, fixed when the last batch landed. */
  rate: number;
  /** Moving average of the time between batches. */
  gapMs: number;
  /** When the last batch landed, or null before the first. */
  lastArrivalMs: number | null;
  /** Length of the target at the last batch, to detect a new one. */
  targetLength: number;
  /** Some text arrived while not yet final: the reply was streamed, not
   *  delivered whole. */
  streamed: boolean;
}

export const initialPacer = (shown = 0): Pacer => ({
  shown,
  rate: 0,
  gapMs: INITIAL_GAP_MS,
  lastArrivalMs: null,
  targetLength: shown,
  streamed: false,
});

/**
 * A batch landed: `length` is the target's new length. Re-plan the rate so
 * the backlog drains linearly over the stretched gap (or the catch-up
 * window, when the text is final).
 */
export const onTarget = (
  pacer: Pacer,
  length: number,
  nowMs: number,
  final: boolean,
): Pacer => {
  let gapMs = pacer.gapMs;
  if (pacer.lastArrivalMs !== null && length > pacer.targetLength) {
    const gap = Math.min(MAX_GAP_MS, nowMs - pacer.lastArrivalMs);
    gapMs = 0.7 * gapMs + 0.3 * gap;
  }
  const backlog = Math.max(0, length - pacer.shown);
  // Final before anything was streamed or shown: the answer arrived whole,
  // and flows in rather than popping in. Derived from what arrived, not
  // from call order, so planning the same batch twice (StrictMode runs
  // effects twice) gives the same pace.
  const whole = final && !pacer.streamed && pacer.shown === 0;
  const window = whole
    ? Math.min(
        WHOLE_MAX_MS,
        Math.max(CATCH_UP_MS, backlog / WHOLE_CHARS_PER_MS),
      )
    : final
      ? CATCH_UP_MS
      : gapMs * STRETCH;
  return {
    ...pacer,
    gapMs,
    lastArrivalMs: length > pacer.targetLength ? nowMs : pacer.lastArrivalMs,
    targetLength: length,
    streamed: pacer.streamed || (!final && length > 0),
    rate: backlog / Math.max(1, window),
  };
};

/**
 * Advance by `elapsedMs`: how far into the target the reveal may reach now.
 * Never past the target, never backwards, and at least one character per
 * frame while there is a backlog, so a tiny rate cannot stall the reveal.
 */
export const advance = (
  pacer: Pacer,
  targetLength: number,
  elapsedMs: number,
): Pacer => {
  if (pacer.shown >= targetLength) return { ...pacer, shown: targetLength };
  const step = Math.max(1, pacer.rate * elapsedMs);
  return { ...pacer, shown: Math.min(targetLength, pacer.shown + step) };
};

/** A table's delimiter row: `| --- | :-: |`, `---|---`. */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Where the reveal may cut so a table never flashes as raw text. Until its
 * delimiter row has arrived, a table's header line is just a paragraph of
 * pipes, and it snaps into a table a moment later (the text visibly
 * shrinks as the pipes turn into cells). So a trailing run of
 * pipe lines with no complete delimiter row yet is held back, and appears
 * as a table at once when it can.
 */
export const holdPartialTable = (text: string, end: number): number => {
  const shown = text.slice(0, end);
  const lines = shown.split("\n");
  // A line break just after the header (the next line not started yet)
  // leaves an empty last line: it belongs to the forming table, not after
  // it. Caught by replaying a live answer: "| a | b |\n" still rendered as
  // a paragraph of pipes.
  const tail = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  // The trailing run of lines that start with a pipe.
  let first = tail;
  while (first > 0 && lines[first - 1]!.trimStart().startsWith("|")) first--;
  if (first === tail) return end;
  const run = lines.slice(first, tail);
  // Header plus a delimiter row that is complete: a line after it, or the
  // text ends there.
  const ready =
    run.length >= 2 &&
    TABLE_SEPARATOR.test(run[1]!) &&
    (run.length > 2 || tail < lines.length || end === text.length);
  if (ready) return end;
  // Back to the start of the run (the line breaks before it stay).
  return lines.slice(0, first).join("\n").length + (first > 0 ? 1 : 0);
};

const SEGMENTER =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Whitespace a word boundary sits after (space, tab, newline, NBSP). */
const SPACE = /\s/;

/** How far back a word boundary is looked for. A run of text longer than
 *  this with no space in it (CJK prose, a long URL) is revealed grapheme by
 *  grapheme instead, so it still flows. */
const WORD_REACH = 48;

/**
 * Where the reveal may actually cut: the last word boundary at or before
 * `position`, so a word appears whole. A word still in reach of the cut is
 * held back until it is complete; only a run with no space in reach (CJK, a
 * long URL) falls back to the last grapheme boundary, so an emoji or a
 * combining mark is never split.
 */
export const cutAt = (text: string, position: number): number => {
  const at = Math.floor(position);
  if (at >= text.length) return text.length;
  if (at <= 0) return 0;
  // A boundary is the position right after whitespace.
  const floor = Math.max(0, at - WORD_REACH);
  for (let i = at; i > floor; i--) {
    if (SPACE.test(text[i - 1]!)) return i;
  }
  // No space in reach. Near the start of the text this is just the first
  // word, still being revealed: hold it back. Further in, it is a long
  // space-less run: flow through it by grapheme.
  if (floor === 0) return 0;
  if (!SEGMENTER) return at;
  let last = 0;
  for (const { index } of SEGMENTER.segment(text.slice(0, at + 4))) {
    if (index > at) break;
    last = index;
  }
  return last;
};
