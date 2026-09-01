import { describe, expect, it } from "vitest";
import { foldTranscript } from "@/lib/chat/transcript";

// The EXACT batch sequence captured from Guy's live Slack turn on
// 2026-08-31 (PROBE batch kinds, in arrival order). No thinking.delta:
// this agent has no model set, so reasoning never came. The loader must
// still narrate from tool events alone.
const LIVE = [
  ["turn.started"],
  ["text.delta"],
  ["text.delta"],
  ["text.delta", "tool.started", "tool.finished"],
  ["text.delta", "tool.started"],
  ["tool.finished"],
  ["text.delta", "tool.started", "tool.finished"],
  ["text.delta", "text", "turn.done"],
];

describe("the live turn, replayed through the shipped fold", () => {
  it("narrates from tool events alone, then clears on turn.done", () => {
    let seq = 0;
    const events: unknown[] = [];
    const seen: (string | undefined)[] = [];

    for (const batch of LIVE) {
      for (const type of batch) {
        const payload =
          type === "tool.started"
            ? { callId: `c${seq}`, name: "bash" }
            : type === "tool.finished"
              ? { callId: `c${seq}`, name: "bash", output: "ok" }
              : type === "text.delta" || type === "text"
                ? { text: "hi" }
                : {};
        events.push({ seq: seq++, turnId: "t1", type, payload });
      }
      const turns = foldTranscript(events as never);
      seen.push(turns[0]?.activity);
    }

    // While tools run, the row says what is happening.
    expect(seen.slice(3, 7)).toEqual([
      "Running a command",
      "Running a command",
      "Running a command",
      "Running a command",
    ]);
    // And the turn ending takes it down — never left standing over an answer.
    expect(seen.at(-1)).toBeUndefined();
  });
});
