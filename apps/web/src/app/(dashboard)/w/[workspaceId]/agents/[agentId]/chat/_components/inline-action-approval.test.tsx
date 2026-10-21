// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingChannelApprovalItem } from "@/lib/api/channel-approvals";

/**
 * The chat's inline ACTION approvals (an agent asking to message another
 * agent): the web twin of the Slack DM card. It surfaces in the agent's own
 * thread where the asking turn ran - never another agent's, never another
 * conversation's, never a reach ask - and decides through the same door as
 * the bell row.
 */

const state = vi.hoisted(() => ({
  items: [] as PendingChannelApprovalItem[],
  mutate: vi.fn(),
}));

vi.mock("@/hooks/use-approvals", () => ({
  usePendingChannelApprovals: () => ({ data: state.items }),
  useDecideChannelAction: () => ({ mutate: state.mutate, isPending: false }),
  useApproveCustomConnection: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { useActionApprovalCards } = await import("./use-action-approval-cards");
const { InlineActionApproval } = await import("./inline-action-approval");

const action = (
  over: Partial<Extract<PendingChannelApprovalItem, { kind: "action" }>>,
): PendingChannelApprovalItem => ({
  kind: "action",
  id: "act-1",
  agentId: "donna",
  agentName: "Donna",
  summary: 'Donna wants to talk to Mark: "what time is it?"',
  offersAlwaysAllow: true,
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
    {useActionApprovalCards(agentId, conversationId).map((card) => (
      <InlineActionApproval key={card.item.id} item={card.item} />
    ))}
  </div>
);

describe("inline action approvals in the chat", () => {
  beforeEach(() => {
    state.items = [];
    state.mutate.mockReset();
  });

  it("shows only THIS agent's holds raised in THIS conversation", () => {
    state.items = [
      action({ id: "mine" }),
      action({ id: "other-thread", conversationId: "conv-elsewhere" }),
      action({ id: "bell-only", conversationId: null }),
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
    expect(screen.getAllByText(/wants to talk to Mark/)).toHaveLength(1);
  });

  it("decides through the same door as the bell row", async () => {
    state.items = [action({})];
    render(<Cards agentId="donna" conversationId="conv-home" />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(state.mutate).toHaveBeenCalledWith({
      approvalId: "act-1",
      decision: "approve",
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
    });
  });

  it("renders nothing when there is nothing to decide", () => {
    const { container } = render(
      <Cards agentId="donna" conversationId="conv-home" />,
    );
    expect(container.textContent).toBe("");
  });
});
