// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingChannelApprovalItem } from "@/lib/api/channel-approvals";
import type { Turn } from "@/lib/api/types";
import { ChatThread } from "./chat-thread";

/**
 * The chat thread renders the channel approvals the listing anchors to it,
 * from the real hook and card: a scheduled run's hold arrives with the
 * conversation its schedule reports to (the server maps it), so it shows
 * here, and another thread's hold does not.
 */

const items = vi.hoisted(() => ({ list: [] as PendingChannelApprovalItem[] }));

vi.mock("@/hooks/use-approvals", () => ({
  usePendingChannelApprovals: () => ({ data: items.list }),
  useDecideChannelAction: () => ({ mutate: vi.fn(), isPending: false }),
  useApproveCustomConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useDecideChannelReach: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("./use-approval-cards", () => ({ useApprovalCards: () => [] }));
vi.mock("./turn-block", () => ({ TurnBlock: () => null }));
vi.mock("./user-bubble", () => ({ UserBubble: () => null }));
vi.mock("./load-older-sentinel", () => ({ LoadOlderSentinel: () => null }));
vi.mock("./scroll-on-send", () => ({ ScrollOnSend: () => null }));
vi.mock("./scroll-to-end-button", () => ({ ScrollToEndButton: () => null }));
vi.mock("./empty-thread-welcome", () => ({ EmptyThreadWelcome: () => null }));

const turn: Turn = {
  id: "t-1",
  conversationId: "conv-chat",
  status: "done",
  source: "web",
  userId: "u1",
  message: "check my inbox every morning",
  error: null,
  errorCode: null,
  usage: null,
  followUpOfTurnId: null,
  attachments: [],
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-11-03T08:00:00.000Z",
};

const hold = (
  id: string,
  summary: string,
  conversationId: string,
): PendingChannelApprovalItem => ({
  kind: "action",
  id,
  agentId: "donna",
  agentName: "Donna",
  summary,
  standingChoice: false,
  conversationId,
  createdAt: "2026-11-03T09:00:00.000Z",
  expiresAt: "2026-11-04T09:00:00.000Z",
  customConnection: null,
  webhookChange: null,
});

describe("ChatThread channel approvals", () => {
  it("shows a scheduled run's hold in the chat it reports to, never another thread's", () => {
    items.list = [
      hold("run", "send the morning digest to Alex", "conv-chat"),
      hold("elsewhere", "reply in another thread", "conv-other"),
    ];
    render(
      <ChatThread
        turns={[turn]}
        folded={new Map()}
        conversationId="conv-chat"
        agentId="donna"
        agentName="Donna"
      />,
    );
    expect(
      screen.getByText("send the morning digest to Alex"),
    ).toBeInTheDocument();
    expect(screen.queryByText("reply in another thread")).toBeNull();
  });
});
