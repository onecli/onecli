// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingChannelApprovalItem } from "@/lib/api/channel-approvals";

/**
 * The chat's inline channel approvals (here, an agent asking to message
 * another agent, and a reach ask): the web twin of the Slack DM card. It
 * surfaces in the agent's own thread - never another agent's, never another
 * conversation's - and decides through the same door as the bell row.
 */

const state = vi.hoisted(() => ({
  items: [] as PendingChannelApprovalItem[],
  mutate: vi.fn(),
}));

vi.mock("@/hooks/use-approvals", () => ({
  usePendingChannelApprovals: () => ({ data: state.items }),
  useDecideChannelAction: () => ({ mutate: state.mutate, isPending: false }),
  useApproveCustomConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useDecideChannelReach: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/ee/slack-read/slack-access-card", () => ({
  SlackAccessCard: ({ item }: { item: { summary: string } }) => (
    <div data-testid="slack-access-card">{item.summary}</div>
  ),
}));
vi.mock("next/dynamic", () => ({
  default: (load: () => Promise<unknown>) => {
    // Resolve the (mocked) module synchronously enough for the test: the
    // dynamic wrapper renders the loaded component once ready.
    let Loaded: ((p: object) => unknown) | null = null;
    void load().then((c) => {
      Loaded = c as (p: object) => unknown;
    });
    return (props: object) => (Loaded ? Loaded(props) : null);
  },
}));

const { useChannelApprovalCards } =
  await import("./use-channel-approval-cards");
const { InlineChannelApproval } = await import("./inline-channel-approval");

const action = (
  over: Partial<Extract<PendingChannelApprovalItem, { kind: "action" }>>,
): PendingChannelApprovalItem => ({
  kind: "action",
  id: "act-1",
  agentId: "donna",
  agentName: "Donna",
  summary: 'Donna wants to talk to Mark: "what time is it?"',
  standingChoice: false,
  conversationId: "conv-home",
  createdAt: "2026-10-08T05:26:08Z",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  webhookChange: null,
  customConnection: null,
  ...over,
});

/** The thread's share, rendered as a column (minus timeline slotting). */
const Cards = ({
  agentId,
  conversationId,
}: {
  agentId: string;
  conversationId: string;
}) => (
  <div>
    {useChannelApprovalCards(agentId, conversationId).map((card) => (
      <InlineChannelApproval key={card.item.id} item={card.item} />
    ))}
  </div>
);

describe("inline channel approvals in the chat", () => {
  beforeEach(() => {
    state.items = [];
    state.mutate.mockReset();
  });

  it("shows what the bell shows for THIS agent, except another thread's holds", () => {
    state.items = [
      action({ id: "mine" }),
      action({ id: "other-thread", conversationId: "conv-elsewhere" }),
      // A hold anchored on no conversation (the receiving side of a
      // cross-workspace message): the bell used to be its only surface.
      action({ id: "no-thread", conversationId: null }),
      action({ id: "other-agent", agentId: "mark", agentName: "Mark" }),
      {
        kind: "reach",
        id: "reach-1",
        agentId: "donna",
        agentName: "Donna",
        provider: "slack",
        subjectKind: "space",
        subjectLabel: "#general",
        externalRef: "C1",
        createdAt: "2026-10-08T05:26:08Z",
      },
    ];
    render(<Cards agentId="donna" conversationId="conv-home" />);
    // "mine" and "no-thread" (both Donna's own holds).
    expect(screen.getAllByText(/wants to talk to Mark/)).toHaveLength(2);
    // The reach ask renders with the bell's own row.
    expect(screen.getByText(/#general/)).toBeInTheDocument();
  });

  it("decides through the same door as the bell row", async () => {
    state.items = [action({})];
    render(<Cards agentId="donna" conversationId="conv-home" />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(state.mutate).toHaveBeenCalledWith({
      approvalId: "act-1",
      decision: "approve",
      standing: false,
    });
  });

  it("a webhook change shows the full new instructions before Approve", async () => {
    const instructions = `Save the notes to the Meetings folder.\n\n${"Then file each item. ".repeat(60)}`;
    state.items = [
      action({
        summary: 'change webhook "Meeting notes": pause it, new instructions …',
        webhookChange: { name: null, instructions, enabled: false },
      }),
    ];
    render(<Cards agentId="donna" conversationId="conv-home" />);
    // The summary line is clamped; the card carries every word.
    expect(screen.getByLabelText("New instructions").textContent).toBe(
      instructions,
    );
    expect(screen.getByText("Pause")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(state.mutate).toHaveBeenCalledWith({
      approvalId: "act-1",
      decision: "approve",
      standing: false,
    });
  });

  it("renders nothing when there is nothing to decide", () => {
    const { container } = render(
      <Cards agentId="donna" conversationId="conv-home" />,
    );
    expect(container.textContent).toBe("");
  });

  it("a Slack access request renders the access card (server summary), not the generic row", async () => {
    state.items = [
      action({
        summary: "Connect your Slack so Donna can read as you",
        slackAccess: {
          kind: "read",
          reason: "not_connected",
          conversationLabel: null,
        },
      }),
    ];
    // Let the lazy module settle, then render.
    await new Promise((r) => setTimeout(r, 0));
    render(<Cards agentId="donna" conversationId="conv-home" />);
    expect(screen.getByTestId("slack-access-card").textContent).toBe(
      "Connect your Slack so Donna can read as you",
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
