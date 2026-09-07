// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { Turn } from "@/lib/api/types";
import { queryKeys } from "@/lib/api/keys";
import type { RenderedTurn } from "@/lib/chat/transcript";
import { TurnBlock } from "./turn-block";

// Only the connect-card wiring test below renders the card's subtree; the
// mocks keep its router/dialog dependencies out of this suite.
vi.mock("next/navigation", () => ({
  useParams: () => ({ agentId: "agent-1" }),
  usePathname: () => "/w/ws-1/agents/agent-1/chat",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../../_components/manage-permissions-dialog", () => ({
  ManagePermissionsDialog: () => null,
}));

const turn = (overrides: Partial<Turn> = {}): Turn => ({
  id: "t1",
  conversationId: "c1",
  status: "done",
  source: "web",
  userId: null,
  message: "run the report",
  error: null,
  errorCode: null,
  usage: null,
  followUpOfTurnId: null,
  attachments: [],
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-08-05T00:00:00Z",
  ...overrides,
});

const rendered = (overrides: Partial<RenderedTurn> = {}): RenderedTurn => ({
  turnId: "t1",
  text: "",
  work: [],
  liveText: "",
  notices: [],
  tools: [],
  ended: true,
  ...overrides,
});

describe("TurnBlock", () => {
  it("renders the user message and the agent's markdown answer", () => {
    render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({ text: "Here is **the answer**." })}
      />,
    );
    expect(screen.getByText("run the report")).toBeInTheDocument();
    expect(screen.getByText("the answer")).toHaveProperty("tagName", "STRONG");
  });

  it("renders follow-ups BETWEEN the question and the answer — the answer stays last", () => {
    // The live-found ordering bug: a joined follow-up used to render below
    // the whole answer block, so the reply visually attached to the first
    // message and the follow-up dangled unanswered. The exchange must read
    // question → follow-up(s) → answer.
    render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({ text: "Covers both." })}
        followUps={[
          turn({
            id: "f1",
            status: "joined",
            message: "oh, i mean, say yo",
            followUpOfTurnId: "t1",
          }),
        ]}
      />,
    );
    const question = screen.getByText("run the report");
    const followUp = screen.getByText("oh, i mean, say yo");
    const answer = screen.getByText("Covers both.");
    expect(
      question.compareDocumentPosition(followUp) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      followUp.compareDocumentPosition(answer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a still-steering follow-up carries the received hint; a joined one is plain", () => {
    render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({ ended: false })}
        followUps={[
          turn({ id: "f1", status: "joining", message: "first tweak" }),
          turn({ id: "f2", status: "joined", message: "second tweak" }),
        ]}
      />,
    );
    expect(screen.getByText(/Received, folding it in/)).toBeInTheDocument();
    expect(screen.getByText("first tweak")).toBeInTheDocument();
    expect(screen.getByText("second tweak")).toBeInTheDocument();
  });

  it("shows a tool call with its output behind a disclosure, as text", async () => {
    const user = userEvent.setup();
    render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({
          tools: [
            {
              callId: "call1",
              name: "web_search",
              output: "<script>alert(1)</script> results",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("web_search")).toBeInTheDocument();
    await user.click(screen.getByText("web_search"));
    const output = screen.getByText(/results/);
    expect(output.textContent).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
  });

  it("renders the running turn as a work log, in stream order, as plain text", () => {
    // The live view is a chronological log: narration, the tool that closed
    // it, then the still-streaming tail. Narration is UNTRUSTED mid-turn
    // model text and must render as TEXT — markdown syntax stays literal
    // (the answer bubble is the only markdown surface).
    const { container } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          work: [
            { kind: "narration", text: "Let me **check** the logs." },
            {
              kind: "tool",
              tool: { callId: "c1", name: "bash", output: "ok" },
            },
          ],
          liveText: "Now the config.",
        })}
      />,
    );
    // Markdown stays literal — the ** marks render as characters.
    const narration = screen.getByText("Let me **check** the logs.");
    expect(narration).toBeInTheDocument();
    expect(container.querySelector("strong")).toBeNull();
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText(/Now the config\./)).toBeInTheDocument();
    // Stream order: narration precedes the tool row, which precedes the tail.
    const tool = screen.getByText("bash");
    const tail = screen.getByText(/Now the config\./);
    expect(
      narration.compareDocumentPosition(tool) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      tool.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("silences the caption while narration streams — the words are the signal", () => {
    render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          liveText: "Looking at the failing test now.",
          activity: "Running a command",
        })}
      />,
    );
    expect(screen.queryByText("Running a command")).not.toBeInTheDocument();
    // …and back when the agent goes quiet (a tool closes the segment). A
    // whitespace-only tail counts as quiet too — a bare newline must not
    // blank the caption row.
    render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          liveText: " \n ",
          activity: "Running a command",
        })}
      />,
    );
    expect(screen.getByText("Running a command")).toBeInTheDocument();
  });

  it("drops the narration and promotes only the answer when the turn settles", () => {
    // The fade-away decision (1a): the work log is transient by design —
    // history carries no deltas, so what a refresh shows and what the live
    // viewer ends on must agree: tools + answer, no narration.
    const { rerender } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          work: [
            { kind: "narration", text: "Let me check the logs." },
            {
              kind: "tool",
              tool: { callId: "c1", name: "bash", output: "ok" },
            },
          ],
          liveText: "CI passed",
        })}
      />,
    );
    expect(screen.getByText("Let me check the logs.")).toBeInTheDocument();

    rerender(
      <TurnBlock
        turn={turn({ status: "done" })}
        rendered={rendered({
          ended: true,
          text: "CI passed; nothing to do.",
          work: [
            { kind: "narration", text: "Let me check the logs." },
            {
              kind: "tool",
              tool: { callId: "c1", name: "bash", output: "ok" },
            },
          ],
          tools: [{ callId: "c1", name: "bash", output: "ok" }],
        })}
      />,
    );
    expect(
      screen.queryByText("Let me check the logs."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("CI passed; nothing to do.")).toBeInTheDocument();
    // The tool record survives the settle — only narration is transient.
    expect(screen.getByText("bash")).toBeInTheDocument();
  });

  it("prefers the turn row's error — the one witness when no event arrived", () => {
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: "The agent restarted. Send the message again.",
        })}
        rendered={rendered({ error: "some folded error" })}
      />,
    );
    expect(
      screen.getByText("The agent restarted. Send the message again."),
    ).toBeInTheDocument();
    expect(screen.queryByText("some folded error")).not.toBeInTheDocument();
  });

  it("holds the waiting state while the poll still says active — no raw-error flash", () => {
    // The transcript stream's raw `error` event lands a beat before the
    // turns poll settles the status and delivers the canonical copy. While
    // the poll says ACTIVE, the stream's raw text must not flash.
    render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({ ended: true, error: "raw provider blob" })}
      />,
    );
    expect(screen.queryByText("raw provider blob")).not.toBeInTheDocument();
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("still shows the stream's error once the turn settles without a row error", () => {
    // The fallback witness: an uncoded failure whose turn.result carried no
    // error string leaves turn.error null — the folded stream error is the
    // only record, and hiding it on a SETTLED turn would hide the failure.
    render(
      <TurnBlock
        turn={turn({ status: "failed", error: null })}
        rendered={rendered({ error: "the stream's own error" })}
      />,
    );
    expect(screen.getByText("the stream's own error")).toBeInTheDocument();
  });

  it("says it is waking before the agent runs, thinking once it does", () => {
    const { rerender } = render(
      <TurnBlock turn={turn({ status: "queued" })} rendered={undefined} />,
    );
    expect(screen.getByText("Waking the agent…")).toBeInTheDocument();

    rerender(
      <TurnBlock turn={turn({ status: "running" })} rendered={undefined} />,
    );
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("marks an aborted turn as stopped", () => {
    render(
      <TurnBlock turn={turn({ status: "aborted" })} rendered={undefined} />,
    );
    expect(screen.getByText("Stopped.")).toBeInTheDocument();
  });
});

describe("a platform automation delivery turn", () => {
  it("renders a watch report as a system label, never the user's bubble", () => {
    const { container } = render(
      <TurnBlock
        turn={turn({
          source: "watch",
          userId: null,
          message: 'Watch on "sleep 90;"',
        })}
        rendered={rendered({ text: "The machine time is 12:00." })}
      />,
    );
    // The platform header shows as a quiet label…
    expect(screen.getByText('Watch on "sleep 90;"')).toBeInTheDocument();
    // …the report body still renders on the agent side…
    expect(screen.getByText("The machine time is 12:00.")).toBeInTheDocument();
    // …and it is NOT a right-aligned user bubble with a "via watch" chip (the
    // exact regression). MUTATION-PROOF: revert turn-block to the unconditional
    // <UserBubble> and both the end-aligned bubble and the chip reappear.
    expect(container.querySelector('[data-align="end"]')).toBeNull();
    expect(screen.queryByText(/via watch/i)).not.toBeInTheDocument();
  });

  it("renders a scheduled-run (cron) report the same system way", () => {
    const { container } = render(
      <TurnBlock
        turn={turn({
          source: "cron",
          userId: null,
          message: 'Scheduled run "daily digest"',
        })}
        rendered={rendered({ text: "Digest ready." })}
      />,
    );
    expect(
      screen.getByText('Scheduled run "daily digest"'),
    ).toBeInTheDocument();
    expect(screen.getByText("Digest ready.")).toBeInTheDocument();
    expect(container.querySelector('[data-align="end"]')).toBeNull();
  });
});

describe("the origin chip", () => {
  it('says "via Slack" on a turn that entered through the Slack door', () => {
    render(
      <TurnBlock
        turn={turn({ source: "slack" })}
        rendered={rendered({ text: "Done." })}
      />,
    );
    expect(screen.getByText("via Slack")).toBeInTheDocument();
  });

  it("stays silent for a web turn — home needs no label", () => {
    render(<TurnBlock turn={turn()} rendered={rendered({ text: "Done." })} />);
    expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
  });
});

describe("a turn that could not run for a reason the reader can fix", () => {
  it("offers the fix instead of a red error, keyed on the CODE", () => {
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: "This agent doesn't have a model key yet.",
          errorCode: "no_model_key",
        })}
        rendered={undefined}
        modelsHref="/w/p1/agents/a1/models"
      />,
    );
    const action = screen.getByRole("link", { name: "Connect a model key" });
    expect(action).toHaveAttribute("href", "/w/p1/agents/a1/models");
    // Guidance, not a crash: none of the destructive treatment.
    expect(document.querySelector(".text-destructive")).toBeNull();
  });

  it("opens the in-place door instead of navigating when one is wired", async () => {
    // With onConnectModelKey provided, the fix happens OVER the chat — a
    // button, not a link, so nothing leaves the conversation.
    const user = userEvent.setup();
    const onConnectModelKey = vi.fn();
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: "This agent doesn't have a model key yet.",
          errorCode: "no_model_key",
        })}
        rendered={undefined}
        modelsHref="/w/p1/agents/a1/models"
        onConnectModelKey={onConnectModelKey}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Connect a model key" }),
    );
    expect(onConnectModelKey).toHaveBeenCalledTimes(1);
  });

  it("a provider refusal still NAVIGATES even when the in-place door exists", () => {
    // Deliberate asymmetry: checking an existing key means editing it, and
    // the chat has no edit door — the Models page does.
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: "The agent's model provider rejected the request.",
          errorCode: "model_provider_error",
        })}
        rendered={undefined}
        modelsHref="/w/p1/agents/a1/models"
        onConnectModelKey={vi.fn()}
      />,
    );
    const action = screen.getByRole("link", { name: "Check the model key" });
    expect(action).toHaveAttribute("href", "/w/p1/agents/a1/models");
    expect(
      screen.queryByRole("button", { name: "Check the model key" }),
    ).toBeNull();
  });

  it("offers the key check for a model-provider refusal — same door, its own label", () => {
    // A key EXISTS but the provider refused it (limit, expiry): the fix
    // lives on the same Models page, and the label says "check", not
    // "connect". Keyed on the CODE, never the message text.
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error:
            "The agent's model provider rejected the request. This is usually a usage limit or an expired key.",
          errorCode: "model_provider_error",
        })}
        rendered={undefined}
        modelsHref="/w/p1/agents/a1/models"
      />,
    );
    const action = screen.getByRole("link", { name: "Check the model key" });
    expect(action).toHaveAttribute("href", "/w/p1/agents/a1/models");
    expect(document.querySelector(".text-destructive")).toBeNull();
  });

  it("a provider refusal without a models href keeps the notice, minus the door", () => {
    // Outside the agent page there is no destination to offer — the
    // guidance still renders as the quiet notice, just with no action.
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: "The agent's model provider rejected the request.",
          errorCode: "model_provider_error",
        })}
        rendered={undefined}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "The agent's model provider rejected the request.",
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector(".text-destructive")).toBeNull();
  });

  it("trial-credit exhaustion opens the in-place add-key door, like no_model_key", async () => {
    // The free credit ran out: there is no user key to check, so the fix is
    // ADDING one — the same in-place door as no_model_key (not the Models
    // navigation the provider-refusal arm takes), with its own label.
    const user = userEvent.setup();
    const onConnectModelKey = vi.fn();
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error:
            "This agent was running on OneCLI's free trial credit, which is now used up.",
          errorCode: "trial_credit_exhausted",
        })}
        rendered={undefined}
        modelsHref="/w/p1/agents/a1/models"
        onConnectModelKey={onConnectModelKey}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Add your own model key" }),
    );
    expect(onConnectModelKey).toHaveBeenCalledTimes(1);
    // Guidance, not a crash: none of the destructive treatment.
    expect(document.querySelector(".text-destructive")).toBeNull();
  });

  it("trial-credit exhaustion navigates to Models when no in-place door is wired", () => {
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error:
            "This agent was running on OneCLI's free trial credit, which is now used up.",
          errorCode: "trial_credit_exhausted",
        })}
        rendered={undefined}
        modelsHref="/w/p1/agents/a1/models"
      />,
    );
    const action = screen.getByRole("link", {
      name: "Add your own model key",
    });
    expect(action).toHaveAttribute("href", "/w/p1/agents/a1/models");
    expect(document.querySelector(".text-destructive")).toBeNull();
  });

  it.each([
    "agent_restarted",
    "agent_start_failed",
    "at_capacity",
    "image_unavailable",
    "turn_stalled",
    "turn_time_limit",
  ])("renders a %s failure as a quiet notice, not the red box", (errorCode) => {
    // A platform hiccup whose copy already says what to do — red would say
    // the agent is broken. Read off the CODE, never the message text.
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: "The agent had to restart while working on this.",
          errorCode,
        })}
        rendered={undefined}
        modelsHref="/w/p1/agents/a1/models"
      />,
    );
    // The POSITIVE pin: the notice treatment (role=status), not merely the
    // absence of red — a bare unstyled <p> would otherwise pass.
    expect(screen.getByRole("status")).toHaveTextContent(
      "The agent had to restart while working on this.",
    );
    expect(document.querySelector(".text-destructive")).toBeNull();
    // And no action link — the sentence is the whole guidance.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps the plain error treatment for every other failure", () => {
    // The code is what switches the rendering — never the message text.
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: "The agent restarted. Send the message again.",
          errorCode: null,
        })}
        rendered={undefined}
        modelsHref="/w/p1/agents/a1/models"
      />,
    );
    expect(
      screen.queryByRole("link", { name: "Connect a model key" }),
    ).toBeNull();
    expect(
      screen.getByText("The agent restarted. Send the message again."),
    ).toHaveClass("text-destructive");
  });

  it("renders a notice alongside an answer, without ending the turn", () => {
    // The whole reason `notice` is not an `error` event: the agent degraded to
    // a different model AND still answered, so both belong on screen.
    render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({
          text: "Done.",
          notices: ["The model claude-nope isn't available here."],
        })}
      />,
    );
    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(
      screen.getByText("The model claude-nope isn't available here."),
    ).toBeInTheDocument();
  });

  it("renders the connect card under an answer that carried a connect link — and drops the link from the prose", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(queryKeys.connections.list("workspace"), []);
    queryClient.setQueryData(queryKeys.grants.agent("agent-1"), {
      agentId: "agent-1",
      mode: "grants",
      connections: [],
      secrets: [],
    });
    queryClient.setQueryData(
      [...queryKeys.agents.all(), "agent-1", "effective-credentials"],
      { agentId: "agent-1", mode: "selective", secrets: [], connections: [] },
    );
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <TurnBlock
          turn={turn()}
          rendered={rendered({
            text: "Connect it here: https://app.onecli.sh/w/a/connections?connect=gmail&source=agent&agent_name=Arik",
          })}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Apps that could help")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect Gmail" }),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain("connections?connect");
  });
});
