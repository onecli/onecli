// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Turn } from "@/lib/api/types";
import type { RenderedTurn } from "@/lib/chat/transcript";
import { PairThread } from "./pair-thread";

/**
 * The pair view as a person reads it (PR 5b): this agent's words on the
 * dark side, the peer's on the white side, nothing else. The WHICH is
 * `pairBubbles`' (tested as a pure function); this suite checks the draw:
 * sides, styling, labels, and that the machinery never reaches the DOM.
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

const rendered = (over: Partial<RenderedTurn> & { turnId: string }) =>
  ({
    text: "",
    lead: "",
    liveText: "",
    notices: [],
    peerMessages: [],
    peerMessagesOpeningTask: new Set<number>(),
    tools: [],
    ended: true,
    ...over,
  }) satisfies RenderedTurn;

describe("PairThread", () => {
  it("captions the own bubble that opened a task and draws the task's closing line", () => {
    render(
      <PairThread
        agentName="Donna"
        peerName="Ray"
        turns={[
          turn({ id: "t1" }),
          turn({ id: "t2", message: "Ray (agent): Friday works" }),
          turn({ id: "t3" }),
        ]}
        folded={
          new Map([
            [
              "t1",
              rendered({
                turnId: "t1",
                peerMessages: ["Can you ship by Friday?"],
                peerMessagesOpeningTask: new Set([0]),
              }),
            ],
            ["t2", rendered({ turnId: "t2" })],
            ["t3", rendered({ turnId: "t3", peerTaskClosed: "budget" })],
          ])
        }
      />,
    );
    const own = screen.getByLabelText("Donna said");
    expect(within(own).getByText("For a person")).toBeInTheDocument();
    expect(
      within(own).getByText("Can you ship by Friday?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Out of messages. Closed without a report."),
    ).toHaveAttribute("role", "status");
  });

  it("draws this agent's messages dark on the right and the peer's white on the left, in order", () => {
    render(
      <PairThread
        agentName="Donna"
        peerName="Ray"
        turns={[
          turn({ id: "t1" }),
          turn({ id: "t2", message: "Ray (agent): 4" }),
        ]}
        folded={
          new Map([
            ["t1", rendered({ turnId: "t1", peerMessages: ["what is 2+2?"] })],
            [
              "t2",
              rendered({
                turnId: "t2",
                text: 'Replied to Ray with "4" — delivery is pending.',
                notices: ["To Ray: noted"],
                tools: [{ callId: "c1", name: "message_agent", output: "{}" }],
              }),
            ],
          ])
        }
      />,
    );

    const own = screen.getByLabelText("Donna said");
    expect(own).toHaveAttribute("data-align", "end");
    expect(within(own).getByText("what is 2+2?")).toBeInTheDocument();
    // The dark bubble: the primary variant, the same as a person's message.
    const ownBubble = own.querySelector("[data-slot=bubble]");
    expect(ownBubble).toHaveAttribute("data-variant", "default");

    const peer = screen.getByLabelText("Ray said");
    expect(peer).toHaveAttribute("data-align", "start");
    expect(within(peer).getByText("4")).toBeInTheDocument();
    const peerBubble = peer.querySelector("[data-slot=bubble]");
    expect(peerBubble).toHaveAttribute("data-variant", "outline");

    // Order: the opener, then the answer.
    const labels = screen
      .getAllByLabelText(/said$/)
      .map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["Donna said", "Ray said"]);

    // The machinery stays out: narration, the notice, the tool name, the
    // frame.
    expect(screen.queryByText(/Replied to Ray/)).toBeNull();
    expect(screen.queryByText(/To Ray/)).toBeNull();
    expect(screen.queryByText(/message_agent/)).toBeNull();
    expect(screen.queryByText(/\(agent\)/)).toBeNull();
  });

  it("says so when there is nothing yet, and marks a turn that failed without an answer", () => {
    const { rerender } = render(
      <PairThread
        agentName="Donna"
        peerName="Ray"
        turns={[]}
        folded={new Map()}
      />,
    );
    expect(screen.getByText("No messages yet.")).toBeInTheDocument();

    rerender(
      <PairThread
        agentName="Donna"
        peerName="Ray"
        turns={[
          turn({ id: "t1", status: "failed", message: "Ray (agent): hi" }),
        ]}
        folded={new Map([["t1", rendered({ turnId: "t1", error: "boom" })]])}
      />,
    );
    expect(screen.queryByText("No messages yet.")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Donna couldn’t answer.",
    );
    // The failure's own words are the direct chat's business, not this
    // view's.
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("a paused pair ends with the pause line, and only then", () => {
    const { rerender } = render(
      <PairThread
        agentName="Donna"
        peerName="Ray"
        turns={[turn({ id: "t1", message: "Ray (agent): hi" })]}
        folded={new Map()}
        paused
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/^Paused\./);
    // The line is the LAST thing: after the peer's message.
    const all = [
      ...document.querySelectorAll("[data-slot=message], [role=status]"),
    ];
    expect(all.at(-1)?.getAttribute("role")).toBe("status");

    rerender(
      <PairThread
        agentName="Donna"
        peerName="Ray"
        turns={[turn({ id: "t1", message: "Ray (agent): hi" })]}
        folded={new Map()}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
