// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@/lib/api/approvals";

/**
 * The chat's inline approval strip: a held request must surface INSIDE the
 * conversation it blocks — filtered to this agent, wired to the shared
 * decision pair, and invisible (no reserved space) when nothing is pending.
 */

const state = vi.hoisted(() => ({
  approvals: [] as PendingApproval[],
  mutate: vi.fn(),
  agent: { id: "ag-1", name: "Support Triage" } as {
    id: string;
    name: string;
  },
}));

// The hooks are mocked; the local-decision map (record / forget / take) is
// the REAL module-level one, so these tests exercise the same memory the
// production mutation writes.
vi.mock("@/hooks/use-approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-approvals")>()),
  usePendingApprovals: () => ({ data: state.approvals }),
  useDecideApproval: () => ({
    mutate: state.mutate,
    isPending: false,
    variables: undefined,
  }),
}));

vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => state.agent,
  useAgentPageAgentMaybe: () => state.agent,
}));

const { useApprovalCards } = await import("./use-approval-cards");
const { InlineApprovalItem } = await import("./inline-approval-item");
const { recordLocalDecision, forgetLocalDecision, takeLocalDecision } =
  await import("@/hooks/use-approvals");

/** Test harness: every card as one column — what the chat thread does with
 * `useApprovalCards`, minus the timeline slotting. */
const Cards = () => {
  const cards = useApprovalCards();
  if (cards.length === 0) return null;
  return (
    <div>
      {cards.map(({ approval, settled }) => (
        <InlineApprovalItem
          key={approval.id}
          approval={approval}
          settled={settled}
        />
      ))}
    </div>
  );
};

const approval = (
  overrides: Partial<PendingApproval> = {},
): PendingApproval => ({
  id: "ap-1",
  method: "POST",
  url: "https://api.github.com/repos/acme/site/issues",
  host: "api.github.com",
  path: "/repos/acme/site/issues",
  headers: {},
  summary: { action: "Create a GitHub issue", details: [] },
  agent: { id: "ag-1", name: "Support Triage" },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  ...overrides,
});

beforeEach(() => {
  state.approvals = [];
  state.mutate.mockClear();
  state.agent = { id: "ag-1", name: "Support Triage" };
  // The local-decision map is module-level session memory — drain the ids
  // these tests use so one test's click never leaks into the next.
  for (const id of ["ap-1", "ap-2", "ap-a", "ap-b", "ap-donna"]) {
    takeLocalDecision(id);
  }
});

describe("inline approval cards", () => {
  it("renders a pending approval with its actions wired", async () => {
    const user = userEvent.setup();
    state.approvals = [approval()];
    render(<Cards />);

    expect(screen.getByText("Create a GitHub issue")).toBeInTheDocument();
    // Countdown: ~2 minutes away, labeled so it cannot read as a timestamp.
    expect(screen.getByText(/^expires in [12]:\d{2}$/)).toBeInTheDocument();
    // The request path rides the meta line; the stakes ride the footer.
    expect(
      screen.getByText("api.github.com/repos/acme/site/issues"),
    ).toBeInTheDocument();
    expect(screen.getByText("Undecided means denied.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(state.mutate).toHaveBeenCalledWith(
      { id: "ap-1", decision: "approve" },
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(state.mutate).toHaveBeenCalledWith(
      { id: "ap-1", decision: "deny" },
      expect.anything(),
    );
  });

  it("keeps the card actionable at countdown 0 — only the poll settles it", () => {
    // The poll is the authority on liveness: a fast client clock hitting 0
    // must not hide the Approve/Deny the header bell still offers.
    render(
      <InlineApprovalItem
        approval={approval({
          expiresAt: new Date(Date.now() - 5_000).toISOString(),
        })}
      />,
    );

    expect(screen.getByText("expires in 0:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("filters out another agent's approvals — this strip is this thread's", () => {
    state.approvals = [
      approval({
        id: "ap-2",
        summary: { action: "Send a Stripe refund", details: [] },
        agent: { id: "ag-OTHER", name: "Billing Bot" },
      }),
    ];
    const { container } = render(<Cards />);

    expect(screen.queryByText("Send a Stripe refund")).not.toBeInTheDocument();
    // Nothing of this agent's → nothing at all, not an empty frame.
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing at all when the list is empty — no reserved space", () => {
    const { container } = render(<Cards />);
    expect(container).toBeEmptyDOMElement();
  });

  it("records this browser's own click precisely — Approved / Denied", () => {
    state.approvals = [
      approval({ id: "ap-a", summary: { action: "Ship it", details: [] } }),
      approval({ id: "ap-b", summary: { action: "Wipe it", details: [] } }),
    ];
    const view = render(<Cards />);

    // What useDecideApproval's onMutate does: record the outcome, then the
    // optimistic update drops the id from the pending list.
    recordLocalDecision("ap-a", "approved");
    recordLocalDecision("ap-b", "denied");
    state.approvals = [];
    view.rerender(<Cards />);

    expect(screen.getByText(/· Approved/)).toBeInTheDocument();
    expect(screen.getByText(/· Denied/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument();
  });

  it("forgets a rolled-back decision — the departure falls back to the heuristic", () => {
    state.approvals = [approval()];
    const view = render(<Cards />);

    recordLocalDecision("ap-1", "approved");
    forgetLocalDecision("ap-1"); // what onError does on rollback
    state.approvals = [];
    view.rerender(<Cards />);

    // Far from its deadline and no own click on record → some other
    // surface decided it.
    expect(screen.getByText(/· Decided/)).toBeInTheDocument();
    expect(screen.queryByText(/Approved/)).not.toBeInTheDocument();
  });

  it("labels a deadline departure with the auto-deny outcome", () => {
    state.approvals = [
      approval({ expiresAt: new Date(Date.now() + 5_000).toISOString() }),
    ];
    const view = render(<Cards />);

    state.approvals = [];
    view.rerender(<Cards />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Expired (no response) · denied",
    );
  });

  it("never carries a settled card across an agent switch", async () => {
    // Donna's approval is live, then decided: it becomes a settled record row
    // in HER thread.
    state.agent = { id: "ag-donna", name: "Donna" };
    state.approvals = [
      approval({
        id: "ap-donna",
        summary: { action: "Send a Stripe refund", details: [] },
        agent: { id: "ag-donna", name: "Donna" },
      }),
    ];
    const view = render(<Cards />);
    expect(screen.getByText("Send a Stripe refund")).toBeInTheDocument();

    state.approvals = [];
    view.rerender(<Cards />);
    expect(screen.getByText("Send a Stripe refund")).toBeInTheDocument();

    // Same mounted hook, different agent — the chat route survives an agent
    // switch, so Martin must NOT inherit Donna's card.
    state.agent = { id: "ag-martin", name: "Martin" };
    view.rerender(<Cards />);
    expect(screen.queryByText("Send a Stripe refund")).not.toBeInTheDocument();
    expect(view.container).toBeEmptyDOMElement();

    // And returning to Donna still shows her own record.
    state.agent = { id: "ag-donna", name: "Donna" };
    view.rerender(<Cards />);
    expect(screen.getByText("Send a Stripe refund")).toBeInTheDocument();
  });

  it("resurrects the live card when an optimistic removal rolls back — never a duplicate", () => {
    state.approvals = [approval()];
    const view = render(<Cards />);
    expect(screen.getAllByText("Create a GitHub issue")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();

    // useDecideApproval optimistically drops the id from the cache: the
    // session records a settled row.
    state.approvals = [];
    view.rerender(<Cards />);
    expect(screen.getByText(/Decided/)).toBeInTheDocument();

    // The mutation fails and React Query rolls back — the id is live again.
    // Exactly one card, the actionable one: the settled record must give way.
    state.approvals = [approval()];
    view.rerender(<Cards />);
    expect(screen.getAllByText("Create a GitHub issue")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.queryByText(/Decided/)).not.toBeInTheDocument();

    // Departing for real afterwards records the settled row exactly once.
    state.approvals = [];
    view.rerender(<Cards />);
    expect(screen.getAllByText(/Decided/)).toHaveLength(1);
  });
});
