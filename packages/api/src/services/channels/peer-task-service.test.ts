import { describe, expect, it } from "vitest";
import {
  MAX_PEER_TASK_ASK_CHARS,
  PEER_TASK_IDLE_MINUTES,
  PEER_TASK_MESSAGE_BUDGET,
  cleanAsk,
  homeTaskContext,
  ownerTaskContext,
  peerTaskCloseLine,
  peerTaskContext,
  peerTaskPair,
  peerTaskPairRecord,
  peerTaskReportHeader,
  type ClosedPeerTask,
  type PeerTaskRow,
} from "./peer-task-service";

/**
 * The pure half of the peer-task service: the pair key, the ask cleaner,
 * and the WORDS — what each side reads while a task is open and what the
 * person reads when it ends. The DB half (open/queue/spend/close/promote/
 * sweep) is proven against Postgres in `agent-links.pg.test.ts`.
 */

const row = (over: Partial<PeerTaskRow> = {}): PeerTaskRow => ({
  id: "task-1",
  agentId: "donna",
  peerAgentId: "ray",
  homeConversationId: "home",
  createdByUserId: "owner",
  ask: "ask Ray if he can ship by Friday",
  opener: "Can you ship by Friday?",
  status: "open",
  outcome: null,
  agentSent: 1,
  peerSent: 0,
  awaitingPeer: true,
  lastPeerText: null,
  openedAt: new Date("2026-09-17T00:00:00Z"),
  expiresAt: new Date("2026-09-17T00:30:00Z"),
  ...over,
});

const closed = (
  outcome: ClosedPeerTask["outcome"],
  over: Partial<PeerTaskRow> = {},
): ClosedPeerTask => ({
  task: row(over),
  outcome,
  agentName: "Donna",
  peerName: "Ray",
});

describe("peerTaskPair", () => {
  it("sorts the pair so both directions share one key", () => {
    expect(peerTaskPair("b", "a")).toEqual({ pairAId: "a", pairBId: "b" });
    expect(peerTaskPair("a", "b")).toEqual({ pairAId: "a", pairBId: "b" });
  });
});

describe("cleanAsk", () => {
  it("strips control characters, collapses whitespace, bounds", () => {
    expect(cleanAsk("ask\u0007  Ray\n\nnow ")).toBe("ask Ray now");
    expect(cleanAsk("x".repeat(5000))).toHaveLength(MAX_PEER_TASK_ASK_CHARS);
    expect(cleanAsk("   ")).toBe("");
  });
});

describe("the owner's task context", () => {
  it("quotes the person's ask as data, counts both budgets, and names the one way out", () => {
    const text = ownerTaskContext(row({ agentSent: 2, peerSent: 1 }), "Ray");
    expect(text).toContain(
      "They asked you, in another conversation: “ask Ray if he can ship by Friday”",
    );
    expect(text).toContain("the person does not see this conversation");
    expect(text).toContain(
      `You can send ${PEER_TASK_MESSAGE_BUDGET - 2} more messages; Ray can reply ${PEER_TASK_MESSAGE_BUDGET - 1} more times`,
    );
    expect(text).toContain("call complete_task with the report");
    expect(text).toContain("only that report reaches them");
  });

  it("uses singulars at one and never goes negative", () => {
    const text = ownerTaskContext(
      row({
        agentSent: PEER_TASK_MESSAGE_BUDGET - 1,
        peerSent: PEER_TASK_MESSAGE_BUDGET + 3,
      }),
      "Ray",
    );
    expect(text).toContain("You can send 1 more message;");
    expect(text).toContain("Ray can reply 0 more times");
  });
});

describe("the peer's task context", () => {
  it("says a person is behind the questions and how many replies are left, never the person's words", () => {
    const text = peerTaskContext(row({ peerSent: 5 }), "Donna");
    expect(text).toBe(
      "Donna is asking on behalf of a person. You can reply 1 more time in this task; answer as completely as you can.",
    );
    expect(text).not.toContain("Friday");
  });
});

describe("the home's standing line", () => {
  it("names the peer, quotes the ask, and says the report lands here on its own", () => {
    const text = homeTaskContext(row(), "Ray");
    expect(text).toContain("You have a task open with Ray");
    expect(text).toContain("“ask Ray if he can ship by Friday”");
    expect(text).toContain("lands here on its own");
    expect(text).toContain("within the same task");
  });
});

describe("the person's close line", () => {
  it("says why, then hands over the peer's last message when there is one", () => {
    const text = peerTaskCloseLine(
      closed("budget", { lastPeerText: "Friday works, not the UI." }),
    );
    expect(text).toBe(
      "Donna used up its messages with Ray before reporting back.\n\nRay’s last message: “Friday works, not the UI.”",
    );
  });

  it("says the peer never answered when the task ran with no reply", () => {
    expect(peerTaskCloseLine(closed("expired"))).toBe(
      `Donna did not report back after ${PEER_TASK_IDLE_MINUTES} minutes without progress.\n\nRay never answered.`,
    );
  });

  it("says the task never started for a queued one that was closed", () => {
    expect(
      peerTaskCloseLine(
        closed("blocked", { openedAt: null, status: "queued" }),
      ),
    ).toBe(
      "Messaging between Donna and Ray was blocked before Donna could report back.\n\nThe task never started.",
    );
  });

  it("has a head for every backstop outcome, with curly apostrophes and no em dashes", () => {
    for (const outcome of [
      "budget",
      "expired",
      "blocked",
      "removed",
      "undeliverable",
    ] as const) {
      const text = peerTaskCloseLine(closed(outcome));
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toContain("—");
      expect(text).not.toContain("'");
    }
  });
});

describe("the pair record and the report header", () => {
  it("has a short line per outcome and the one caption", () => {
    expect(peerTaskPairRecord(closed("reported"))).toBe(
      "Reported back to the person.",
    );
    expect(peerTaskPairRecord(closed("undeliverable"))).toContain(
      "could not be delivered",
    );
    expect(peerTaskReportHeader("Ray")).toBe("After talking with Ray");
  });
});
