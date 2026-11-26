import { describe, expect, it } from "vitest";
import {
  CATCH_UP_MS,
  WHOLE_MAX_MS,
  advance,
  cutAt,
  holdPartialTable,
  initialPacer,
  onTarget,
} from "./smooth-reveal";

const FRAME = 1000 / 60;

/**
 * Recorded arrival times of a real turn (ms, characters): the stream's
 * text frames as the browser read them. Today each one is painted at once,
 * up to 163 characters in a single frame.
 */
const RECORDED: [number, number][] = [
  [5494, 125],
  [5809, 36],
  [6332, 134],
  [6748, 163],
  [7167, 144],
  [7733, 197],
];
/** The durable answer arrived in the same read as the last delta. */
const FINAL_AT = 7733;

/** Drive the pacer frame by frame over the recorded arrivals. */
const replay = () => {
  let pacer = initialPacer();
  let target = 0;
  let next = 0;
  const perFrame: number[] = [];
  let doneAt: number | null = null;
  const end = RECORDED.at(-1)![0] + 2_000;
  for (let t = RECORDED[0]![0]; t < end; t += FRAME) {
    while (next < RECORDED.length && RECORDED[next]![0] <= t) {
      target += RECORDED[next]![1];
      pacer = onTarget(pacer, target, t, RECORDED[next]![0] >= FINAL_AT);
      next++;
    }
    const before = pacer.shown;
    pacer = advance(pacer, target, FRAME);
    perFrame.push(pacer.shown - before);
    if (doneAt === null && next === RECORDED.length && pacer.shown >= target) {
      doneAt = t;
    }
  }
  return { perFrame, doneAt: doneAt! };
};

describe("smooth reveal pacing, on a recorded turn", () => {
  it("never reveals more than a few words in one frame", () => {
    // Today: up to 163 characters land in a single frame.
    const { perFrame } = replay();
    expect(Math.max(...perFrame)).toBeLessThanOrEqual(20);
  });

  it("is caught up within the catch-up window after the final text", () => {
    const { doneAt } = replay();
    expect(doneAt - FINAL_AT).toBeLessThanOrEqual(CATCH_UP_MS + FRAME * 2);
  });

  it("barely pauses between batches mid-stream", () => {
    // Frames with nothing new while more text is still coming. Today: 130
    // of them (every frame between two network reads).
    const { perFrame } = replay();
    const streaming = perFrame.slice(
      0,
      Math.floor((FINAL_AT - RECORDED[0]![0]) / FRAME),
    );
    expect(streaming.filter((n) => n === 0).length).toBeLessThanOrEqual(10);
  });
});

describe("smooth reveal edges", () => {
  /** Drive one final, whole text frame by frame from nothing shown. */
  const wholeAnswer = (length: number) => {
    let pacer = onTarget(initialPacer(), length, 0, true);
    const perFrame: number[] = [];
    let t = 0;
    while (pacer.shown < length && t < 10_000) {
      const before = pacer.shown;
      pacer = advance(pacer, length, FRAME);
      perFrame.push(pacer.shown - before);
      t += FRAME;
    }
    return { perFrame, tookMs: t };
  };

  it("flows in an answer that arrives whole, at a reading pace", () => {
    // An answer after tool calls can land as ONE ~900-character frame.
    const { perFrame, tookMs } = wholeAnswer(929);
    expect(Math.max(...perFrame)).toBeLessThanOrEqual(12);
    expect(tookMs).toBeGreaterThan(1_000);
    expect(tookMs).toBeLessThanOrEqual(WHOLE_MAX_MS + FRAME * 2);
  });

  it("never makes the reader wait long on a long whole answer", () => {
    const { tookMs } = wholeAnswer(3_700);
    expect(tookMs).toBeLessThanOrEqual(WHOLE_MAX_MS + FRAME * 2);
  });

  it("shows a short whole answer almost at once", () => {
    const { tookMs } = wholeAnswer(2);
    expect(tookMs).toBeLessThanOrEqual(CATCH_UP_MS + FRAME * 2);
  });

  it("still catches up fast on the final text after a stream", () => {
    let pacer = onTarget(initialPacer(), 100, 0, false);
    pacer = advance(pacer, 100, 400);
    pacer = onTarget(pacer, 900, 420, true);
    expect(pacer.rate).toBeGreaterThanOrEqual(
      (900 - pacer.shown) / CATCH_UP_MS - 1e-9,
    );
  });
  it("never moves backwards or past the target", () => {
    let pacer = onTarget(initialPacer(), 10, 0, false);
    for (let i = 0; i < 100; i++) pacer = advance(pacer, 10, FRAME);
    expect(pacer.shown).toBe(10);
    expect(advance({ ...pacer, shown: 12 }, 10, FRAME).shown).toBe(10);
  });

  it("keeps moving even when the planned rate rounds to nothing", () => {
    const pacer = onTarget(initialPacer(), 1, 0, false);
    expect(advance(pacer, 1, 0.001).shown).toBe(1);
  });

  it("a long pause (a tool running) does not slow the next reveal", () => {
    let pacer = onTarget(initialPacer(), 100, 0, false);
    pacer = advance(pacer, 100, 10_000);
    const after = onTarget(pacer, 200, 30_000, false);
    // The gap is capped, so the rate stays in the same range as before.
    expect(after.gapMs).toBeLessThan(1_000);
  });
});

describe("holdPartialTable", () => {
  const intro = "Here it is:\n\n";
  it("holds a header row back until its delimiter row is complete", () => {
    const text = `${intro}| Loud | Calm |\n| --- | --- |\n| a | b |`;
    const header = intro.length + "| Loud | Calm |".length;
    expect(holdPartialTable(text, header)).toBe(intro.length);
    // The delimiter row is still arriving.
    expect(holdPartialTable(text, header + 6)).toBe(intro.length);
    // Delimiter complete and a row started: a table, show it.
    const rowStart = text.indexOf("| a");
    expect(holdPartialTable(text, rowStart + 3)).toBe(rowStart + 3);
  });

  it("holds a header row that ends in its line break (the live case)", () => {
    const text = `${intro}| Aspect | Value |\n|---|---|\n| a | b |`;
    const afterHeader = text.indexOf("\n|---");
    expect(holdPartialTable(text, afterHeader + 1)).toBe(intro.length);
    // Delimiter row done and its line break in: a table can render.
    const afterSep = text.indexOf("\n| a");
    expect(holdPartialTable(text, afterSep + 1)).toBe(afterSep + 1);
  });

  it("shows a two-line table that ends the text", () => {
    const text = `${intro}| A | B |\n|---|---|`;
    expect(holdPartialTable(text, text.length)).toBe(text.length);
  });

  it("leaves text with no trailing pipe lines alone", () => {
    const text = "| not | a table\n\nThen a paragraph.";
    expect(holdPartialTable(text, text.length)).toBe(text.length);
    expect(holdPartialTable("plain words", 5)).toBe(5);
  });
});

describe("cutAt", () => {
  it("cuts after whole words only", () => {
    const text = "Hello brave new world";
    expect(cutAt(text, 8)).toBe(6); // "Hello |"
    expect(cutAt(text, 13)).toBe(12); // "Hello brave |"
    expect(cutAt(text, text.length)).toBe(text.length);
    expect(cutAt(text, 0)).toBe(0);
  });

  it("holds the first word back until it is whole", () => {
    expect(cutAt("Hello world", 3)).toBe(0);
  });

  it("flows through a long space-less run by grapheme (CJK, a URL)", () => {
    const text = "日本語のテキスト".repeat(10);
    expect(cutAt(text, 60)).toBe(60);
  });

  it("never splits an emoji or a combining mark", () => {
    const text = "👍🏽".repeat(30);
    // Each thumbs-up with its skin tone is 4 UTF-16 units and one grapheme.
    for (let i = 0; i <= text.length; i++) {
      expect(cutAt(text, i) % 4).toBe(0);
    }
  });
});
