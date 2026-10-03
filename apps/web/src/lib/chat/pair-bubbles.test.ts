import { describe, expect, it } from "vitest";
import type { Turn } from "@/lib/api/types";
import type { RenderedTurn } from "./transcript";
import { pairBubbles, stripPeerFrame, taskClosedLine } from "./pair-bubbles";

/**
 * The pair view's one decision, tested as the pure function it is: which
 * turn contributes which bubble, and that the machinery (tools, narration,
 * notices) never becomes one.
 */

const turn = (over: Partial<Turn> & { id: string }): Turn => ({
  conversationId: "cv",
  status: "done",
  source: "agent",
  userId: null,
  message: "",
  error: null,
  errorCode: null,
  usage: null,
  followUpOfTurnId: null,
  attachments: [],
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-09-16T00:00:00Z",
  ...over,
});

const rendered = (
  over: Partial<RenderedTurn> & { turnId: string },
): RenderedTurn => ({
  text: "",
  lead: "",
  liveText: "",
  notices: [],
  peerMessages: [],
  peerMessagesOpeningTask: new Set<number>(),
  tools: [],
  ended: true,
  ...over,
});

const fold = (...items: RenderedTurn[]) =>
  new Map(items.map((item) => [item.turnId, item]));

describe("pairBubbles", () => {
  it("reads the dialogue: the peer's framed turn is white, this agent's record is dark, in order", () => {
    // Donna's side: her opener (record row, words on the stamp), Ray's
    // answer (delivered turn, framed), her follow-up (record row).
    const bubbles = pairBubbles(
      [
        turn({ id: "t1" }),
        turn({ id: "t2", message: "Ray (agent): 4" }),
        turn({ id: "t3" }),
      ],
      fold(
        rendered({ turnId: "t1", peerMessages: ["what is 2+2?"] }),
        rendered({
          turnId: "t2",
          // The machinery on the delivered turn: never a bubble.
          text: "Ray answered 4. Noted.",
          notices: ["Approved and done: …"],
          tools: [{ callId: "c1", name: "message_agent", output: undefined }],
        }),
        rendered({ turnId: "t3", peerMessages: ["thanks"] }),
      ),
    );
    expect(bubbles).toEqual([
      { kind: "own", key: "t1:own:0", text: "what is 2+2?", forPerson: false },
      { kind: "peer", key: "t2:peer", text: "4" },
      { kind: "own", key: "t3:own:0", text: "thanks", forPerson: false },
    ]);
  });

  it("marks the own bubble that OPENED a task for a person, and draws the task's closing line from the pair record", () => {
    const bubbles = pairBubbles(
      [
        turn({ id: "t1" }),
        turn({ id: "t2", message: "Ray (agent): Friday works" }),
        turn({ id: "t3" }),
      ],
      fold(
        rendered({
          turnId: "t1",
          peerMessages: ["Can you ship by Friday?"],
          peerMessagesOpeningTask: new Set([0]),
        }),
        rendered({ turnId: "t2" }),
        // The platform's pair record when complete_task closed the task:
        // a notice with the peerTask stamp, no own message.
        rendered({
          turnId: "t3",
          notices: ["Reported back to the person."],
          peerTaskClosed: "reported",
        }),
      ),
    );
    expect(bubbles).toEqual([
      {
        kind: "own",
        key: "t1:own:0",
        text: "Can you ship by Friday?",
        forPerson: true,
      },
      { kind: "peer", key: "t2:peer", text: "Friday works" },
      { kind: "task_closed", key: "t3:task", outcome: "reported" },
    ]);
  });

  it("never shows narration, tools or notices as messages", () => {
    const bubbles = pairBubbles(
      [turn({ id: "t1", message: "Ray (agent): hi" })],
      fold(
        rendered({
          turnId: "t1",
          text: 'Replied to Ray with "hello" — delivery is pending.',
          liveText: "thinking…",
          notices: ["To Ray: hello"],
          tools: [{ callId: "c1", name: "message_agent", output: "{}" }],
        }),
      ),
    );
    expect(bubbles).toEqual([{ kind: "peer", key: "t1:peer", text: "hi" }]);
  });

  it("a record row with no fold yet (history page not loaded) shows nothing rather than an empty bubble", () => {
    expect(pairBubbles([turn({ id: "t1" })], new Map())).toEqual([]);
  });

  it("a failed turn with no answer shows the quiet failed line; a failed turn that did answer does not", () => {
    const bubbles = pairBubbles(
      [
        turn({ id: "t1", status: "failed", message: "Ray (agent): hi" }),
        turn({ id: "t2", status: "failed", message: "Ray (agent): again" }),
      ],
      fold(
        rendered({ turnId: "t1", error: "no_model_key" }),
        rendered({ turnId: "t2", peerMessages: ["hello"] }),
      ),
    );
    expect(bubbles).toEqual([
      { kind: "peer", key: "t1:peer", text: "hi" },
      { kind: "failed", key: "t1:failed" },
      { kind: "peer", key: "t2:peer", text: "again" },
      { kind: "own", key: "t2:own:0", text: "hello", forPerson: false },
    ]);
  });

  it("a person's own turn on the conversation (a web or Slack message) is not the peer's", () => {
    // Not a lane that exists today for a pair conversation, but the guard
    // is what makes the peer side structural: it is the platform's delivery
    // turn, not any turn.
    const bubbles = pairBubbles(
      [
        turn({ id: "t1", source: "web", userId: "u1", message: "hey Donna" }),
        turn({
          id: "t2",
          source: "agent",
          userId: "u1",
          message: "X (agent): y",
        }),
      ],
      new Map(),
    );
    expect(bubbles).toEqual([]);
  });
});

describe("taskClosedLine", () => {
  it("has a short plain line for every outcome", () => {
    expect(taskClosedLine("reported")).toBe("Reported back to the person.");
    expect(taskClosedLine("budget")).toContain("Out of messages");
    expect(taskClosedLine("expired")).toContain("No progress");
    expect(taskClosedLine("blocked")).toContain("blocked");
    expect(taskClosedLine("removed")).toContain("removed");
    expect(taskClosedLine("undeliverable")).toContain("could not be delivered");
  });
});

describe("stripPeerFrame", () => {
  it("strips our own frame and only our frame", () => {
    expect(stripPeerFrame("Ray (agent): 4")).toBe("4");
    expect(stripPeerFrame("Ray Ban (agent): hi (agent): there")).toBe(
      "hi (agent): there",
    );
    // A multi-line message: only the first line's frame is ours.
    expect(stripPeerFrame("Ray (agent): line one\nRay (agent): two")).toBe(
      "line one\nRay (agent): two",
    );
    // Not framed: untouched.
    expect(stripPeerFrame("(agent): x")).toBe("(agent): x");
    expect(stripPeerFrame("plain")).toBe("plain");
  });
});
