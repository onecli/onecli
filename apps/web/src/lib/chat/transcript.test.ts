import { describe, expect, it } from "vitest";
import type { TurnEvent } from "@/lib/api/types";
import { foldTranscript, highestSeq, mergeEvents } from "./transcript";

/**
 * The reader's logic, tested where it can be: `apps/web` has no component
 * harness, so the decisions live in pure functions and the components stay
 * thin enough to verify by looking.
 */

let seq = 0;
const event = (
  turnId: string,
  type: TurnEvent["type"],
  payload: Record<string, unknown> = {},
): TurnEvent => ({ seq: (seq += 1), turnId, type, payload });

describe("foldTranscript", () => {
  it("REPLACES delta text with the durable answer instead of appending", () => {
    // A live tail receives both the deltas and the final `text`. Appending
    // renders every answer twice — the single most likely way to get this
    // wrong, and invisible until you actually watch a turn stream.
    const turns = foldTranscript([
      event("t1", "text.delta", { text: "It is " }),
      event("t1", "text.delta", { text: "4." }),
      event("t1", "text", { text: "It is 4." }),
      event("t1", "turn.done"),
    ]);

    expect(turns[0]?.text).toBe("It is 4.");
    // And the live tail dies with the answer — rendering both would show
    // the same sentence twice.
    expect(turns[0]?.liveText).toBe("");
  });

  it("repairs a reader that joined mid-turn and missed the deltas", () => {
    // History carries no deltas at all, so for this reader the answer exists
    // only in the `text` event.
    const turns = foldTranscript([
      event("t1", "text", { text: "full answer" }),
    ]);
    expect(turns[0]?.text).toBe("full answer");
  });

  it("streams text into the live tail — never the answer — before it lands", () => {
    const turns = foldTranscript([
      event("t1", "text.delta", { text: "think" }),
      event("t1", "text.delta", { text: "ing…" }),
    ]);
    expect(turns[0]?.liveText).toBe("thinking…");
    // The answer stays empty until the durable `text` event: a consumer of
    // `text` must never mistake streaming narration for the record.
    expect(turns[0]?.text).toBe("");
    expect(turns[0]?.ended).toBe(false);
  });

  it("builds the work log live, then collapses to the answer alone", () => {
    // The reader's half of "the answer is the last message" (supervisor,
    // 2026-08-31). Mid-turn narration is PROGRESS: it streams as deltas so
    // the person sees work happening, and the durable `text` — which
    // carries only the closing message — REPLACES all of it when the turn
    // ends. Without the replace, the narration the supervisor deliberately
    // dropped would live on in the reader.
    const streaming = [
      event("t1", "text.delta", { text: "Let me check the logs." }),
      event("t1", "tool.started", { callId: "c1", name: "bash" }),
      event("t1", "tool.finished", {
        callId: "c1",
        name: "bash",
        output: "ok",
      }),
      event("t1", "text.delta", { text: "CI passed; nothing to do." }),
    ];

    // Mid-turn: the closed segment sits in the work log IN STREAM ORDER
    // (narration, then the tool that closed it), and the open segment is
    // the live tail.
    const live = foldTranscript(streaming);
    expect(live[0]?.work).toEqual([
      { kind: "narration", text: "Let me check the logs." },
      {
        kind: "tool",
        tool: { callId: "c1", name: "bash", output: "ok" },
      },
    ]);
    expect(live[0]?.liveText).toBe("CI passed; nothing to do.");
    expect(live[0]?.text).toBe("");
    expect(live[0]?.ended).toBe(false);

    // Turn ends: only the closing message survives.
    const settled = foldTranscript([
      ...streaming,
      event("t1", "text", { text: "CI passed; nothing to do." }),
      event("t1", "turn.done"),
    ]);
    expect(settled[0]?.text).toBe("CI passed; nothing to do.");
    expect(settled[0]?.text).not.toContain("Let me check the logs.");
    expect(settled[0]?.liveText).toBe("");
    // The work itself stays visible — tools are durable, narration is not.
    expect(settled[0]?.tools).toHaveLength(1);
    expect(settled[0]?.ended).toBe(true);
  });

  it("never pushes a blank segment on back-to-back tool calls", () => {
    // The supervisor's own guard, mirrored: consecutive tools with nothing
    // said between them must not litter the log with empty rows.
    const turns = foldTranscript([
      event("t1", "tool.started", { callId: "c1", name: "bash" }),
      event("t1", "text.delta", { text: "   " }),
      event("t1", "tool.started", { callId: "c2", name: "read" }),
    ]);
    expect(turns[0]?.work.map((item) => item.kind)).toEqual(["tool", "tool"]);
  });

  it("keeps the work log's tool entry in sync with its finish", () => {
    // The log holds the SAME object as `tools`, so a finish folding onto
    // its start updates both views — a stale "running" row in one of them
    // would contradict the other on screen.
    const turns = foldTranscript([
      event("t1", "tool.started", { callId: "c1", name: "bash" }),
      event("t1", "tool.finished", {
        callId: "c1",
        name: "bash",
        output: "hi",
      }),
    ]);
    const logged = turns[0]?.work[0];
    expect(logged?.kind === "tool" && logged.tool.output).toBe("hi");
  });

  it("logs an orphaned finish so late-started work is never invisible", () => {
    const turns = foldTranscript([
      event("t1", "tool.finished", { callId: "c9", name: "curl", output: "x" }),
    ]);
    expect(turns[0]?.work).toHaveLength(1);
    expect(turns[0]?.work[0]?.kind).toBe("tool");
  });

  it("tracks the live activity, and drops it when the turn ends", () => {
    // THE LOADER (user decision, 2026-08-31). The agent's own words while it
    // works, replaced as work moves, gone once the turn is over — the answer
    // is the record, this is the progress.
    const working = foldTranscript([
      event("t1", "thinking.delta", {
        text: "Architecting the narrative arc\nthen I will consider…",
      }),
    ]);
    // First line only — the intent, not the digression.
    expect(working[0]?.activity).toBe("Architecting the narrative arc");

    // A started tool OUTRANKS the reasoning: the plan is now happening.
    const running = foldTranscript([
      event("t1", "thinking.delta", { text: "Architecting the narrative arc" }),
      event("t1", "tool.started", { callId: "c1", name: "bash" }),
    ]);
    expect(running[0]?.activity).toBe("Running a command");

    // Terminal: no current activity. A caption left standing would describe
    // work that already finished.
    const done = foldTranscript([
      event("t1", "thinking.delta", { text: "Architecting the narrative arc" }),
      event("t1", "tool.started", { callId: "c1", name: "bash" }),
      event("t1", "text", { text: "Done." }),
      event("t1", "turn.done"),
    ]);
    expect(done[0]?.activity).toBeUndefined();
    expect(done[0]?.text).toBe("Done.");
  });

  it("keeps the last caption when a reasoning block says nothing", () => {
    // Null (nothing worth showing) must not blank the row — the previous
    // caption is still the truest thing we know.
    const turns = foldTranscript([
      event("t1", "thinking.delta", { text: "Checking the CI logs" }),
      event("t1", "thinking.delta", { text: "   \n  " }),
    ]);
    expect(turns[0]?.activity).toBe("Checking the CI logs");
  });

  it("clears the activity on a failed turn too", () => {
    const turns = foldTranscript([
      event("t1", "thinking.delta", { text: "Checking the CI logs" }),
      event("t1", "error", { message: "the harness died" }),
    ]);
    expect(turns[0]?.activity).toBeUndefined();
    expect(turns[0]?.error).toBe("the harness died");
  });

  it("pairs a tool's finish onto its start", () => {
    const turns = foldTranscript([
      event("t1", "tool.started", { callId: "c1", name: "bash" }),
      event("t1", "tool.finished", {
        callId: "c1",
        name: "bash",
        output: "ok",
      }),
    ]);

    expect(turns[0]?.tools).toEqual([
      { callId: "c1", name: "bash", output: "ok" },
    ]);
  });

  it("shows a running tool as started-without-output", () => {
    const turns = foldTranscript([
      event("t1", "tool.started", { callId: "c1", name: "bash" }),
    ]);
    expect(turns[0]?.tools[0]?.output).toBeUndefined();
  });

  it("keeps a finish whose start never arrived", () => {
    // Dropping it would silently hide work the agent actually did.
    const turns = foldTranscript([
      event("t1", "tool.finished", { callId: "c9", name: "curl", output: "x" }),
    ]);
    expect(turns[0]?.tools).toHaveLength(1);
  });

  it("surfaces an error rather than stopping silently", () => {
    const turns = foldTranscript([
      event("t1", "error", { message: "credential_not_found" }),
    ]);
    expect(turns[0]?.error).toBe("credential_not_found");
    expect(turns[0]?.ended).toBe(true);
  });

  it("keeps turns in arrival order and separates them", () => {
    const turns = foldTranscript([
      event("t1", "text", { text: "first" }),
      event("t2", "text", { text: "second" }),
    ]);
    expect(turns.map((t) => t.turnId)).toEqual(["t1", "t2"]);
    expect(turns.map((t) => t.text)).toEqual(["first", "second"]);
  });
});

describe("mergeEvents", () => {
  it("is idempotent — a replayed event does not duplicate the transcript", () => {
    // The stream replays history before it tails, and a reconnect replays from
    // a cursor, so the same event legitimately arrives twice.
    const a = event("t1", "text", { text: "hi" });
    expect(mergeEvents([a], [a])).toEqual([a]);
  });

  it("orders by seq regardless of arrival order", () => {
    const first = {
      seq: 1,
      turnId: "t1",
      type: "turn.started" as const,
      payload: {},
    };
    const third = {
      seq: 3,
      turnId: "t1",
      type: "turn.done" as const,
      payload: {},
    };
    const second = { seq: 2, turnId: "t1", type: "text" as const, payload: {} };

    expect(mergeEvents([first, third], [second]).map((e) => e.seq)).toEqual([
      1, 2, 3,
    ]);
  });

  it("returns what it held when nothing arrived", () => {
    const held = [event("t1", "turn.done")];
    expect(mergeEvents(held, [])).toBe(held);
  });
});

describe("highestSeq", () => {
  it("is the resume cursor, and 0 for an empty transcript", () => {
    expect(highestSeq([])).toBe(0);
    expect(
      highestSeq([
        { seq: 4, turnId: "t", type: "text", payload: {} },
        { seq: 9, turnId: "t", type: "turn.done", payload: {} },
      ]),
    ).toBe(9);
  });
});
