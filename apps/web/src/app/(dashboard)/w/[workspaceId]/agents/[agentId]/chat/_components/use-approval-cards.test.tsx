// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@/lib/api/approvals";
import {
  MAX_OUTCOME_IDS,
  type ApprovalOutcome,
} from "@/lib/api/approval-outcomes";

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
  /** The API's record of how departed approvals ended. */
  outcomes: new Map<string, ApprovalOutcome>(),
  outcomeAsks: [] as string[][],
}));

vi.mock("@/hooks/use-approval-outcomes", () => ({
  useApprovalOutcomes: (_agentId: string | undefined, ids: string[]) => {
    if (ids.length > 0) state.outcomeAsks.push([...ids]);
    return state.outcomes;
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
const Cards = ({
  replaced,
}: {
  replaced?: ReadonlySet<string>;
} = {}) => {
  const cards = useApprovalCards(replaced);
  if (cards.length === 0) return null;
  return (
    <div>
      {cards.map(({ approval, settled, via, result }) => (
        <InlineApprovalItem
          key={approval.id}
          approval={approval}
          settled={settled}
          via={via}
          result={result}
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
  state.outcomes = new Map();
  state.outcomeAsks = [];
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

  it("a long session asks the record about its newest departures only, never more than the route answers", () => {
    // The route refuses more than MAX_OUTCOME_IDS ids (422): asking about
    // every card a long session ever saw leave would break the read for all.
    const many = Array.from({ length: MAX_OUTCOME_IDS + 5 }, (_, i) =>
      approval({ id: `ap-${String(i).padStart(3, "0")}` }),
    );
    state.approvals = many;
    const view = render(<Cards />);
    state.approvals = [];
    view.rerender(<Cards />);
    const asked = state.outcomeAsks.at(-1) ?? [];
    expect(asked).toHaveLength(MAX_OUTCOME_IDS);
    expect(asked).toContain(many.at(-1)!.id);
    expect(asked).not.toContain(many[0]!.id);
  });

  it("names a decision made in Slack once the API's record says so", () => {
    // The live confusion: the person approved in Slack, and the web card
    // read a vague "Decided elsewhere". The record names how and where.
    state.approvals = [approval()];
    const view = render(<Cards />);
    state.approvals = [];
    view.rerender(<Cards />);
    expect(screen.getByText(/· Decided/)).toBeInTheDocument();
    // Only the guessed departure is asked about.
    expect(state.outcomeAsks.at(-1)).toEqual(["ap-1"]);

    state.outcomes = new Map([
      [
        "ap-1",
        {
          approvalId: "ap-1",
          outcome: "approved",
          via: "slack",
          decidedAt: new Date().toISOString(),
        },
      ],
    ]);
    view.rerender(<Cards />);
    expect(screen.getByRole("status")).toHaveTextContent("Approved in Slack");
  });

  it("says an approved request did nothing, and why, once the record has its result", () => {
    // Live: approved in Slack, Salesforce answered 200 and created none.
    // Without this the agent's fixed resend read as a mystery approval.
    state.approvals = [
      approval({ summary: { action: "Create 9 Accounts", details: [] } }),
    ];
    const view = render(<Cards />);
    state.approvals = [];
    state.outcomes = new Map([
      [
        "ap-1",
        {
          approvalId: "ap-1",
          outcome: "approved",
          via: "slack",
          decidedAt: new Date().toISOString(),
          result: {
            ok: false,
            succeeded: 0,
            total: 9,
            error: "BillingCountry: bad country",
            action: "Create 9 Accounts",
          },
        },
      ],
    ]);
    view.rerender(<Cards />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Approved in Slack");
    expect(status).toHaveTextContent(
      "Created 0 of 9 · BillingCountry: bad country",
    );
  });

  it("asks the record about this browser's own approval too (for its result)", () => {
    state.approvals = [approval()];
    const view = render(<Cards />);
    recordLocalDecision("ap-1", "approved");
    state.approvals = [];
    view.rerender(<Cards />);
    expect(state.outcomeAsks.at(-1)).toEqual(["ap-1"]);
  });

  it("never asks the record about this browser's own click", () => {
    state.approvals = [approval()];
    const view = render(<Cards />);
    recordLocalDecision("ap-1", "denied");
    state.approvals = [];
    view.rerender(<Cards />);
    expect(screen.getByRole("status")).toHaveTextContent("Denied");
    expect(state.outcomeAsks).toEqual([]);
  });

  it("labels a request the person's newer message withdrew as replaced", () => {
    state.approvals = [approval()];
    const view = render(<Cards />);

    state.approvals = [];
    view.rerender(<Cards replaced={new Set(["ap-1"])} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Replaced by your message",
    );
  });

  it("relabels a 'decided' record once the supersede notice arrives", () => {
    // The poll can see the card leave a beat BEFORE the transcript notice
    // names it: the record must not stay a generic "Decided".
    state.approvals = [approval()];
    const view = render(<Cards />);
    state.approvals = [];
    view.rerender(<Cards />);
    expect(screen.getByText(/· Decided/)).toBeInTheDocument();

    view.rerender(<Cards replaced={new Set(["ap-1"])} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Replaced by your message",
    );
    expect(screen.queryByText(/· Decided/)).not.toBeInTheDocument();
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
