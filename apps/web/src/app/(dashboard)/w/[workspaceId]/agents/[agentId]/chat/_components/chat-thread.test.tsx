// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Turn } from "@/lib/api/types";
import { ChatThread } from "./chat-thread";
import { PINNED_ROW } from "./transcript-layout";

let timeline: { kind: string; key: string; at: number }[] = [];
vi.mock("./use-approval-cards", () => ({ useApprovalCards: () => [] }));
vi.mock("./use-action-approval-cards", () => ({
  useActionApprovalCards: () => [],
}));
vi.mock("./approval-timeline", () => ({ useApprovalTimeline: () => timeline }));
vi.mock("./approval-timeline-slot", () => ({
  ApprovalTimelineSlot: ({ entries }: { entries: { key: string }[] }) =>
    entries.map((e) => <p key={e.key} data-testid="card" />),
}));
vi.mock("./turn-block", () => ({
  TurnBlock: ({
    onOpenComputer,
    computerHref,
  }: Pick<
    React.ComponentProps<typeof ChatThread>,
    "onOpenComputer" | "computerHref"
  >) =>
    onOpenComputer ? (
      <button onClick={() => onOpenComputer("req-1")}>Open computer</button>
    ) : computerHref ? (
      <a href={computerHref("req-1")}>Open computer</a>
    ) : null,
}));
vi.mock("./user-bubble", () => ({ UserBubble: () => null }));
vi.mock("./load-older-sentinel", () => ({ LoadOlderSentinel: () => null }));
// The scroll commands themselves are ScrollOnSend's (its own test); here
// only what the thread hands it matters.
vi.mock("./scroll-on-send", () => ({
  ScrollOnSend: ({ sent, pin }: { sent?: unknown; pin: boolean }) => (
    <i data-testid="scroll-on-send" data-sent={!!sent} data-pin={pin} />
  ),
}));
// The real button only renders its content while something sits below the
// fold, which jsdom (no layout) never reports.
vi.mock("./scroll-to-end-button", () => ({
  ScrollToEndButton: ({ generating }: { generating?: boolean }) => (
    <i data-testid="end" data-generating={generating} />
  ),
}));

afterEach(() => {
  timeline = [];
});

const turn = (id: string, status: Turn["status"] = "done"): Turn => ({
  id,
  conversationId: "conv-1",
  status,
  source: "web",
  userId: "u1",
  message: id,
  error: null,
  errorCode: null,
  usage: null,
  followUpOfTurnId: null,
  attachments: [],
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-08-24T00:00:00.000Z",
});

const thread = (props: Partial<React.ComponentProps<typeof ChatThread>>) =>
  render(
    <ChatThread
      turns={[turn("t1"), turn("t2")]}
      folded={new Map()}
      conversationId="conv-1"
      {...props}
    />,
  ).container;

/** The rows that carry a pinned send's viewport-tall room (jsdom has no
 *  layout, so the room is read off the class that makes it). */
const pinnedRows = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"]')]
    .filter((el) => el.classList.contains(PINNED_ROW))
    .map((el) => el.dataset.messageId);
const scrollOnSend = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('[data-testid="scroll-on-send"]')!.dataset;

describe("ChatThread send pin", () => {
  it("forwards the in-place computer action to the turn notice", async () => {
    const onOpenComputer = vi.fn();
    thread({ turns: [turn("t1")], onOpenComputer });
    await userEvent.click(
      screen.getByRole("button", { name: "Open computer" }),
    );
    expect(onOpenComputer).toHaveBeenCalledTimes(1);
    expect(onOpenComputer).toHaveBeenCalledWith("req-1");
  });

  it("forwards the deep-link fallback for hosts without a dock", () => {
    thread({
      turns: [turn("t1")],
      computerHref: (id) => `/computer?takeover=${id}`,
    });
    expect(screen.getByRole("link", { name: "Open computer" })).toHaveAttribute(
      "href",
      "/computer?takeover=req-1",
    );
  });

  it("gives the room to the outgoing bubble, then to the newest row", () => {
    // MUTATION-TESTED: without the room, a short reply leaves the sent
    // message nowhere near the top: the view clamps back to the bottom.
    expect(
      pinnedRows(thread({ pending: { message: "ask" }, pinnedSend: true })),
    ).toEqual(["pending"]);
    expect(pinnedRows(thread({ pinnedSend: true }))).toEqual(["t2"]);
  });

  it("moves the room to a turn that lands after the send, so no gap opens", () => {
    // MUTATION-TESTED: pinned to the sent turn's id, a cron run or another
    // tab's message landing next sat a screen-tall gap below the reply.
    const c = thread({
      turns: [turn("t1"), turn("t2"), turn("cron-1")],
      pinnedSend: true,
    });
    expect(pinnedRows(c)).toEqual(["cron-1"]);
  });

  it("reserves no room for history, a follow-up or a failed send", () => {
    expect(pinnedRows(thread({}))).toEqual([]);
    expect(pinnedRows(thread({ pending: { message: "follow-up" } }))).toEqual(
      [],
    );
  });

  it("hands each send to ScrollOnSend with whether it pins", () => {
    // MUTATION-TESTED: a follow-up passed as a pin jumped a reply already
    // below the fold away from the bubble the reader just sent.
    expect(
      scrollOnSend(thread({ pending: { message: "ask" }, pinnedSend: true })),
    ).toMatchObject({ sent: "true", pin: "true" });
    expect(
      scrollOnSend(thread({ pending: { message: "follow-up" } })),
    ).toMatchObject({ sent: "true", pin: "false" });
    expect(scrollOnSend(thread({}))).toMatchObject({ sent: "false" });
  });

  it("keeps the newest card inside the pinned row, right under the reply", () => {
    // MUTATION-TESTED: after the row, the card lands below its viewport-tall
    // room, out of sight under a still view.
    timeline = [{ kind: "group", key: "g1", at: Date.now() }];
    const c = thread({ pinnedSend: true });
    const cards = c.querySelectorAll('[data-testid="card"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.closest(`[class~="${PINNED_ROW}"]`)).not.toBeNull();
  });

  it("marks the end button as still writing while a send or a run is live", () => {
    // MUTATION-TESTED: without it the held view gives no sign the reply is
    // still growing below the fold.
    const generating = (c: HTMLElement) =>
      c.querySelector<HTMLElement>('[data-testid="end"]')!.dataset.generating;
    expect(
      generating(thread({ turns: [turn("t1"), turn("t2", "running")] })),
    ).toBe("true");
    expect(generating(thread({ pending: { message: "ask" } }))).toBe("true");
    expect(generating(thread({}))).toBe("false");
  });
});
