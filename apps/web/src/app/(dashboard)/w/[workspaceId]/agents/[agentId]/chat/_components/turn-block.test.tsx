// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Turn } from "@/lib/api/types";
import { queryKeys } from "@/lib/api/keys";
import { ApiError } from "@/lib/api/client";
import type { RenderedTurn } from "@/lib/chat/transcript";
import {
  MODEL_EMPTY_RESPONSE_MESSAGE,
  MODEL_REFUSED_MESSAGE,
} from "@onecli/api/validations/conversation";
import { TurnBlock } from "./turn-block";
import { CAPTION_HOLD_MS } from "./activity-line";

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
// The greeting's actions bring the connect card's live graph and the app
// picker; this suite's contract is WHEN they show, so they are a marker.
vi.mock("./greeting-actions", () => ({
  GreetingActions: () => <div data-testid="greeting-actions" />,
}));

// SEND NOW's request, observable without a network.
const sendNow = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    conversations: { ...actual.conversations, sendNow },
  };
});

/** A waiting follow-up's status line can hold SEND NOW, a mutation. A
 *  wrapper (not a parent element), so `rerender` keeps the client and the
 *  tree's state. */
const withQuery = (ui: React.ReactElement) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
};

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
  lead: "",
  liveText: "",
  notices: [],
  supersededApprovalIds: [],
  desktopRequests: new Map(),
  peerMessages: [],
  peerMessagesOpeningTask: new Set<number>(),
  tools: [],
  steps: [],
  reasoning: "",
  ended: true,
  ...overrides,
});

describe("TurnBlock", () => {
  // The reveal's pacing has its own suite (use-smooth-text, smooth-reveal).
  // Here words are shown whole on arrival (reduced motion), so assertions
  // read the text the moment it is rendered.
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the agent's open desktop ask with an Open computer button, and a settled one as a plain line", async () => {
    const onOpenComputer = vi.fn();
    const { rerender } = render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({
          notices: [
            "Needs you on the desktop: sign in",
            "Alex took over the desktop and is done.",
          ],
          desktopRequests: new Map([
            [0, { id: "req-1", outcome: "pending" }],
            [1, { id: "req-1", outcome: "done" }],
          ]),
        })}
        onOpenComputer={onOpenComputer}
        computerHref={(id) => `/computer?takeover=${id}`}
      />,
    );
    const open = screen.getByRole("button", { name: "Open computer" });
    await userEvent.click(open);
    expect(onOpenComputer).toHaveBeenCalledTimes(1);
    expect(onOpenComputer).toHaveBeenCalledWith("req-1");
    expect(screen.queryByRole("link", { name: "Open computer" })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Open computer" }),
    ).toHaveLength(1);
    // Where there is no screen to open: plain text.
    rerender(
      <TurnBlock
        turn={turn()}
        rendered={rendered({
          notices: ["Needs you on the desktop: sign in"],
          desktopRequests: new Map([[0, { id: "req-1", outcome: "pending" }]]),
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open computer" })).toBeNull();
    expect(
      screen.getByText("Needs you on the desktop: sign in"),
    ).toBeInTheDocument();
  });

  it("deep-links a pending desktop ask when no in-place callback is available", () => {
    render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({
          notices: ["Needs you: sign in", "Desktop request finished"],
          desktopRequests: new Map([
            [0, { id: "req-1", outcome: "pending" }],
            [1, { id: "req-2", outcome: "done" }],
          ]),
        })}
        computerHref={(id) => `/computer?takeover=${id}`}
      />,
    );
    expect(screen.getAllByRole("link", { name: "Open computer" })).toHaveLength(
      1,
    );
    expect(screen.getByRole("link", { name: "Open computer" })).toHaveAttribute(
      "href",
      "/computer?takeover=req-1",
    );
  });

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

  it("reads a Hebrew exchange right-to-left: the question, the narration and the answer", () => {
    // The person's bubble, the agent's opening sentence and the settled
    // answer each decide their own direction from their own text, or one
    // of them ends up with its bullets on the left.
    const { rerender } = render(
      <TurnBlock
        turn={turn({ status: "running", message: "תבדוק את ה-deploy בבקשה" })}
        rendered={rendered({
          ended: false,
          lead: "בודק את הלוגים של Cloudflare.",
          tools: [{ callId: "c1", name: "bash" }],
        })}
      />,
    );
    expect(screen.getByText("תבדוק את ה-deploy בבקשה")).toHaveAttribute(
      "dir",
      "rtl",
    );
    expect(screen.getByText("בודק את הלוגים של Cloudflare.")).toHaveAttribute(
      "dir",
      "rtl",
    );

    rerender(
      <TurnBlock
        turn={turn({ message: "תבדוק את ה-deploy בבקשה" })}
        rendered={rendered({
          text: "הכל תקין:\n\n- Worker פעיל\n- אין שגיאות",
        })}
      />,
    );
    expect(screen.getByRole("list")).toHaveAttribute("dir", "rtl");
  });

  it("never shows an approval resume prompt as a message: a turn renders only the answer, a follow-up a quiet line", () => {
    const prompt =
      "Sent as Helper to Sam. Already delivered: don't send it again.";
    const { unmount } = render(
      <TurnBlock
        turn={turn({ source: "approval", message: prompt })}
        rendered={rendered({ text: "Sent to Sam." })}
      />,
    );
    expect(screen.queryByText(prompt)).toBeNull();
    expect(screen.getByText("Sent to Sam.")).toBeTruthy();
    unmount();
    render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({ text: "Done." })}
        followUps={[
          turn({
            id: "f1",
            status: "joined",
            source: "approval",
            message: prompt,
            followUpOfTurnId: "t1",
          }),
        ]}
      />,
    );
    expect(screen.queryByText(prompt)).toBeNull();
    expect(screen.getByText("Continued after your choice")).toBeTruthy();
  });

  it("a desktop resume follow-up shows neither its prompt nor the approval line", () => {
    const prompt = "The person handed the desktop back. Continue.";
    render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({ text: "Done." })}
        followUps={[
          turn({
            id: "f1",
            status: "joined",
            source: "desktop",
            message: prompt,
            followUpOfTurnId: "t1",
          }),
        ]}
      />,
    );
    expect(screen.queryByText(prompt)).toBeNull();
    expect(screen.queryByText("Continued after your choice")).toBeNull();
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

  it("answers a follow-up UNDER its own bubble, and the turn's answer still comes last", () => {
    // The agent replied to the mid-turn message, then kept working.
    // The reply belongs under the message it answers, rendered as the
    // agent's own markdown; the turn's closing answer stays the last word.
    // MUTATION-PROOF: drop the reply and the follow-up reads as ignored.
    render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({ text: "Report sent." })}
        followUps={[
          turn({
            id: "f1",
            status: "joined",
            message: "use the Q3 numbers",
            followUpOfTurnId: "t1",
          }),
        ]}
        followUpRendered={(id) =>
          id === "f1"
            ? rendered({ turnId: "f1", text: "Using the **Q3** numbers." })
            : undefined
        }
      />,
    );
    const followUp = screen.getByText("use the Q3 numbers");
    const reply = screen.getByText("Q3");
    const answer = screen.getByText("Report sent.");
    expect(reply.tagName).toBe("STRONG");
    expect(
      followUp.compareDocumentPosition(reply) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      reply.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a still-steering follow-up carries the received hint; a joined one is plain", () => {
    withQuery(
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

  it("a JOINING follow-up sits BELOW the live work; a JOINED one sits in the exchange above it", () => {
    // A message the agent has not reached yet belongs after what the agent
    // is doing now; the moment it is picked up it moves up into the
    // exchange. MUTATION-PROOF: render both groups in one place and one of
    // the two orderings below breaks.
    withQuery(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({ ended: false, liveText: "Checking the logs" })}
        followUps={[
          turn({ id: "f1", status: "joined", message: "already read" }),
          turn({ id: "f2", status: "joining", message: "not yet read" }),
        ]}
      />,
    );
    const question = screen.getByText("run the report");
    const liveWork = screen.getByText("Checking the logs");
    const joined = screen.getByText("already read");
    const joining = screen.getByText("not yet read");
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(question, joined)).toBe(true);
    expect(follows(joined, liveWork)).toBe(true);
    expect(follows(liveWork, joining)).toBe(true);
  });

  describe("SEND NOW on a waiting follow-up", () => {
    // The run is inside a tool: a step with no result yet.
    const inTool = rendered({
      ended: false,
      tools: [{ callId: "c1", name: "bash" }],
    });
    const waiting = (overrides: Partial<Turn> = {}) =>
      turn({
        id: "f1",
        status: "joining",
        message: "stop and check prod",
        followUpOfTurnId: "t1",
        ...overrides,
      });
    const file = {
      id: "a1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      status: "bound",
    };
    const sendNowButton = () =>
      screen.queryByRole("button", { name: "Send now" });

    it("is offered while the run is inside a tool, beside the received hint", () => {
      withQuery(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={inTool}
          followUps={[waiting()]}
        />,
      );
      expect(screen.getByText(/Received, folding it in/)).toBeInTheDocument();
      expect(sendNowButton()).toBeInTheDocument();
    });

    it("is NOT offered with nothing to move, before the run started, once read, or for a message with files (and those behind it)", () => {
      const cases: {
        turn: Turn;
        rendered: RenderedTurn;
        followUps: Turn[];
      }[] = [
        // Between tools: nothing running to move.
        {
          turn: turn({ status: "running" }),
          rendered: rendered({
            ended: false,
            tools: [{ callId: "c1", name: "bash", output: "ok" }],
          }),
          followUps: [waiting()],
        },
        // The turn has not started its run yet.
        {
          turn: turn({ status: "dispatched" }),
          rendered: inTool,
          followUps: [waiting()],
        },
        // Already read.
        {
          turn: turn({ status: "running" }),
          rendered: inTool,
          followUps: [waiting({ status: "joined" })],
        },
      ];
      for (const scenario of cases) {
        const { unmount } = withQuery(
          <TurnBlock
            turn={scenario.turn}
            rendered={scenario.rendered}
            followUps={scenario.followUps}
          />,
        );
        expect(sendNowButton()).toBeNull();
        unmount();
      }
    });

    it("a message with files, and one sent after it, get it like any other: both join the live run", () => {
      withQuery(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={inTool}
          followUps={[
            waiting({ attachments: [file] }),
            waiting({ id: "f2", message: "and this" }),
          ]}
        />,
      );
      expect(screen.getAllByRole("button", { name: "Send now" })).toHaveLength(
        2,
      );
    });

    it("asks once: in flight it reads 'Sending now…' and is disabled, then 'Asked to read it now'", async () => {
      let accept: (value: { requested: true }) => void = () => {};
      sendNow.mockReturnValueOnce(
        new Promise((resolve) => {
          accept = resolve;
        }),
      );
      withQuery(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={inTool}
          followUps={[waiting()]}
        />,
      );
      await userEvent.click(sendNowButton()!);
      const inFlight = screen.getByRole("button", { name: /Sending now/ });
      expect(inFlight).toBeDisabled();
      expect(sendNow).toHaveBeenCalledTimes(1);
      expect(sendNow.mock.calls[0]?.[0]).toBe("f1");
      accept({ requested: true });
      expect(
        await screen.findByText("Asked to read it now"),
      ).toBeInTheDocument();
      expect(sendNowButton()).toBeNull();
    });

    it("keeps the request's state after the tool ended (the move itself ends it), then shows the agent's answer", async () => {
      sendNow.mockResolvedValueOnce({ requested: true });
      const { rerender } = withQuery(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={inTool}
          followUps={[waiting()]}
        />,
      );
      await userEvent.click(sendNowButton()!);
      expect(
        await screen.findByText("Asked to read it now"),
      ).toBeInTheDocument();
      // The tool is moved: it reports back, so no tool runs any more.
      const afterMove = rendered({
        ended: false,
        tools: [{ callId: "c1", name: "bash", output: "moved" }],
      });
      rerender(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={afterMove}
          followUps={[waiting()]}
        />,
      );
      expect(screen.getByText("Asked to read it now")).toBeInTheDocument();
      rerender(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={afterMove}
          followUps={[waiting()]}
          followUpRendered={() =>
            rendered({
              turnId: "f1",
              ended: false,
              sentNow: { moved: true, toolName: "bash" },
            })
          }
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "Moved bash to the background, reading it now",
      );
      // Read: the row flips, the whole status line goes with the hint.
      rerender(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={afterMove}
          followUps={[waiting({ status: "joined" })]}
        />,
      );
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByText(/Received, folding it in/)).toBeNull();
    });

    it("a refusal that is a state (already read, run ended) is said quietly, and the button comes back", async () => {
      sendNow.mockRejectedValueOnce(
        new ApiError("The agent already has this message", 409),
      );
      withQuery(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={inTool}
          followUps={[waiting()]}
        />,
      );
      await userEvent.click(sendNowButton()!);
      await vi.waitFor(() =>
        expect(toasts.info).toHaveBeenCalledWith(
          "The agent already has this message",
        ),
      );
      expect(toasts.error).not.toHaveBeenCalled();
      expect(sendNowButton()).toBeInTheDocument();
    });

    it("says what the agent did: the tool it moved, by its bare name, as text", () => {
      withQuery(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={rendered({ ended: false })}
          followUps={[waiting()]}
          followUpRendered={() =>
            rendered({
              turnId: "f1",
              ended: false,
              sentNow: { moved: true, toolName: "mcp__x__<b>bash</b>" },
            })
          }
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "Moved <b>bash</b> to the background, reading it now",
      );
      expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    });

    it("says plainly when nothing was moved", () => {
      withQuery(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={inTool}
          followUps={[waiting()]}
          followUpRendered={() =>
            rendered({ turnId: "f1", ended: false, sentNow: { moved: false } })
          }
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "Nothing to move, it'll be read after this step",
      );
    });

    it("a waiting follow-up never shows a reply under it (only its outcome)", () => {
      withQuery(
        <TurnBlock
          turn={turn({ status: "running" })}
          rendered={inTool}
          followUps={[waiting()]}
          followUpRendered={() =>
            rendered({ turnId: "f1", ended: false, liveText: "on it" })
          }
        />,
      );
      expect(screen.queryByText("on it")).toBeNull();
    });
  });

  it("streams a follow-up's reply as it is written, then settles it IN PLACE", () => {
    // The reply's deltas ride the follow-up's own id while the agent
    // writes; the durable `text` replaces them. Both are the same element,
    // formatted as markdown from the first word (open syntax completed),
    // with the "still writing" mark only while it is a draft.
    const followUps = [
      turn({ id: "f1", status: "joined", message: "use the Q3 numbers" }),
    ];
    const { container, rerender } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({ ended: false })}
        followUps={followUps}
        followUpRendered={() =>
          rendered({ turnId: "f1", liveText: "Using the **Q3", ended: false })
        }
      />,
    );
    const draft = screen.getByText("Q3");
    expect(draft.tagName).toBe("STRONG");
    expect(container.querySelector("[data-draft]")).not.toBeNull();
    const element = draft.closest("[data-slot='bubble']");

    rerender(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({ ended: false })}
        followUps={followUps}
        followUpRendered={() =>
          rendered({ turnId: "f1", text: "Using the **Q3** numbers." })
        }
      />,
    );
    const settled = screen.getByText("Q3");
    expect(settled.tagName).toBe("STRONG");
    expect(screen.getByText(/numbers\./)).toBeInTheDocument();
    // Same element: the draft became the answer, nothing was swapped in.
    expect(settled.closest("[data-slot='bubble']")).toBe(element);
    expect(container.querySelector("[data-draft]")).toBeNull();
  });

  it("never shows a follow-up's draft AND the turn's answer at once (poll lag)", () => {
    // The turn's answer arrives on the stream a beat before the turns poll
    // flips the status; for that beat the draft under the follow-up and
    // the answer must not both be on screen.
    const followUps = [
      turn({ id: "f1", status: "joined", message: "add a fun fact" }),
    ];
    const live = rendered({
      turnId: "f1",
      liveText: "Fun fact: dolphins sleep with half their brain.",
      ended: false,
    });
    render(
      <TurnBlock
        // Still "running" by the poll, but the answer is in.
        turn={turn({ status: "running" })}
        rendered={rendered({
          text: "Done.\n\nFun fact: dolphins sleep with half their brain.",
        })}
        followUps={followUps}
        followUpRendered={() => live}
      />,
    );
    expect(screen.getAllByText(/dolphins sleep/)).toHaveLength(1);
  });

  it("drops a follow-up's live tail when the turn ends with those words as ITS answer", () => {
    // The agent answered the follow-up and said nothing more before the
    // turn ended (a stop, or the reply was its last words): the supervisor
    // keeps those words as the TURN's answer, so no `text` ever lands under
    // the follow-up, and the row has no terminal event to clear its tail.
    // The tail must die with the turn, like the turn's own, or the words
    // show twice: as a stale live tail under the bubble and as the answer.
    const followUps = [
      turn({ id: "f1", status: "joined", message: "what is 7 times 6?" }),
    ];
    const live = rendered({
      turnId: "f1",
      liveText: "7 times 6 is 42.",
      ended: false,
    });
    const { rerender } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({ ended: false })}
        followUps={followUps}
        followUpRendered={() => live}
      />,
    );
    expect(screen.getByText("7 times 6 is 42.")).toBeTruthy();

    rerender(
      <TurnBlock
        turn={turn({ status: "done" })}
        rendered={rendered({ text: "7 times 6 is 42.\n\nALL DONE." })}
        followUps={followUps}
        followUpRendered={() => live}
      />,
    );
    // Once, as the turn's answer; never again under the bubble.
    expect(screen.getAllByText(/7 times 6 is 42\./)).toHaveLength(1);
    expect(screen.getByText("ALL DONE.")).toBeTruthy();
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
              name: "acme_lookup",
              output: "<script>alert(1)</script> results",
            },
          ],
        })}
      />,
    );
    // Tool steps are grouped: open the group, then the step. An unknown tool
    // reads "Used a tool" (header and row alike); its raw name shows only
    // inside, above the output.
    await user.click(screen.getByRole("button", { name: /Used a tool/ }));
    const [, step] = screen.getAllByRole("button", { name: /Used a tool/ });
    await user.click(step!);
    expect(screen.getByText("acme_lookup")).toBeInTheDocument();
    const output = screen.getByText(/results/);
    expect(output.textContent).toContain("<script>alert(1)</script>");
    expect(document.querySelector("script")).toBeNull();
  });

  it("discloses optional input while running and retains failed output after settling", async () => {
    const user = userEvent.setup();
    const tool = {
      callId: "input-call",
      name: "bash",
      input: JSON.stringify({ command: "echo '<script>bad()</script>'" }),
    };
    const { container, rerender } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({ ended: false, tools: [tool] })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Running a command/ }));
    await user.click(screen.getByRole("button", { name: /echo/ }));
    expect(screen.getByText("Request")).toBeInTheDocument();
    expect(container.querySelector("pre")?.textContent).toBe(
      JSON.stringify(JSON.parse(tool.input), null, 2),
    );
    expect(screen.queryByText("Output")).toBeNull();
    expect(container.querySelector("script")).toBeNull();

    rerender(
      <TurnBlock
        turn={turn()}
        rendered={rendered({
          tools: [{ ...tool, output: "bash: denied", isError: true }],
        })}
      />,
    );
    // The timeline is the same element across the settle, so the reader's
    // open step stays open: the output appears where they were looking.
    expect(screen.getByText("Request")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("bash: denied")).toHaveClass("text-red-700");
  });

  it("says how long the work took once the turn settles, or that it stopped", () => {
    const tools = [{ callId: "c1", name: "bash", output: "ok" }];
    const times = {
      startedAt: "2026-08-05T00:00:00Z",
      finishedAt: "2026-08-05T00:00:42Z",
    };
    const { rerender } = render(
      <TurnBlock
        turn={turn(times)}
        rendered={rendered({ text: "Done.", tools })}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Worked for 42s/ }),
    ).toBeInTheDocument();
    rerender(
      <TurnBlock
        turn={turn({ ...times, status: "aborted" })}
        rendered={rendered({ tools })}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Stopped after 42s/ }),
    ).toBeInTheDocument();
    // History with no finish time still says what was done.
    rerender(
      <TurnBlock turn={turn()} rendered={rendered({ text: "Done.", tools })} />,
    );
    expect(
      screen.getByRole("button", { name: /Ran a command/ }),
    ).toBeInTheDocument();
  });

  it("keeps a lead it showed when a stream reconnect drops the live text", () => {
    // Deltas are not stored, so a reconnect's replay has no lead: without
    // the hold, the settled answer would jump up under the reader.
    const tools = [{ callId: "c1", name: "bash", output: "ok" }];
    const { rerender } = render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({
          lead: "I'll check the date first.",
          text: "It is Sunday.",
          tools,
        })}
      />,
    );
    expect(screen.getByText("I'll check the date first.")).toBeInTheDocument();
    rerender(
      <TurnBlock
        turn={turn()}
        rendered={rendered({ text: "It is Sunday.", tools })}
      />,
    );
    expect(screen.getByText("I'll check the date first.")).toBeInTheDocument();
  });

  it("folds a draft the reader saw when a tool call closes it", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const tools = [{ callId: "c1", name: "bash", output: "ok" }];
    const { container, rerender } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          tools,
          steps: [{ kind: "tool", index: 0 }],
          liveText: "Now the config.",
        })}
      />,
    );
    rerender(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          tools: [...tools, { callId: "c2", name: "bash" }],
          steps: [
            { kind: "tool", index: 0 },
            { kind: "note", text: "Now the config." },
            { kind: "tool", index: 1 },
          ],
        })}
      />,
    );
    expect(
      container.querySelector("[data-slot='folding-note']"),
    ).not.toBeNull();
  });

  it("never flashes narration in just to fold it (it arrived with the tool)", () => {
    // The note and the tool that closed it can arrive in ONE network read,
    // so the draft was never on screen; playing its collapse would show
    // the words for 300 ms out of nowhere. Motion on, or nothing folds.
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { container, rerender } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          tools: [{ callId: "c1", name: "bash", output: "ok" }],
          steps: [{ kind: "tool", index: 0 }],
        })}
      />,
    );
    rerender(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          tools: [
            { callId: "c1", name: "bash", output: "ok" },
            { callId: "c2", name: "bash" },
          ],
          steps: [
            { kind: "tool", index: 0 },
            { kind: "note", text: "Now the config." },
            { kind: "tool", index: 1 },
          ],
        })}
      />,
    );
    expect(container.querySelector("[data-slot='folding-note']")).toBeNull();
  });

  it("flows in the answer of a turn the reader watched, even when it lands whole", () => {
    // After tool calls the answer usually arrives as ONE text event.
    // Watched, it must read as arriving, not pop in as a block. Motion on.
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    const answer = "The deploy is green and every check passed. ".repeat(12);
    const tools = [{ callId: "c1", name: "bash", output: "ok" }];
    const { container, rerender } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({ ended: false, tools })}
      />,
    );
    rerender(
      <TurnBlock turn={turn()} rendered={rendered({ text: answer, tools })} />,
    );
    const answerText = () =>
      container.querySelector("[data-role='answer']")?.textContent ?? "";
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(answerText().length).toBeLessThan(answer.trim().length / 2);
    for (let i = 0; i < 130; i++) {
      act(() => {
        vi.advanceTimersToNextFrame();
      });
    }
    expect(answerText()).toBe(answer.trim());
    vi.useRealTimers();
  });

  it("shows history's answer whole at once, never replayed", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const answer = "Loaded from history, already complete. ".repeat(12);
    const { container } = render(
      <TurnBlock
        turn={turn()}
        rendered={rendered({
          text: answer,
          tools: [{ callId: "c1", name: "bash", output: "ok" }],
        })}
      />,
    );
    expect(container.querySelector("[data-role='answer']")?.textContent).toBe(
      answer.trim(),
    );
  });

  it("renders the running turn as a work log, in order: the plan, the work, the reply being written", () => {
    // The live view: the agent's opening sentence, the run header for its
    // tool calls, then the reply still being written. All of it formatted
    // through the hardened markdown renderer (no raw HTML; see
    // chat-markdown.test), the opening sentence in a quieter color.
    const { container } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          lead: "Let me **check** the logs.",
          tools: [{ callId: "c1", name: "bash", output: "ok" }],
          liveText: "Now the <b>config</b>.",
        })}
      />,
    );
    const lead = screen.getByText("check").closest("[data-slot='bubble']")!;
    expect(lead).toHaveAttribute("data-role", "lead");
    // Raw HTML stays inert in a draft, exactly as in an answer.
    expect(container.querySelector("b")).toBeNull();
    const tool = screen.getByText("Running a command");
    const tail = screen.getByText(/Now the/);
    expect(
      lead.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      tool.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The reply below the work is a draft until the answer lands.
    expect(tail.closest("[data-draft]")).not.toBeNull();
  });

  it("lists every tool call as a step under one live header", async () => {
    const user = userEvent.setup();
    render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          lead: "I'll fetch the docs.",
          tools: [
            { callId: "a", name: "bash", output: "x" },
            { callId: "b", name: "bash", output: "y" },
          ],
        })}
      />,
    );
    expect(screen.getByText("I'll fetch the docs.")).toBeInTheDocument();
    await user.click(screen.getByText("Running 2 commands"));
    expect(screen.getAllByText("Ran a command")).toHaveLength(2);
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

  it("shows the run header's tool phrase once, but still announces it", () => {
    // The header already says "Running a command"; a visible caption would
    // echo it word for word. It stays in the polite live region (sr-only),
    // the screen reader's progress cue. The agent's own words still show,
    // once the previous caption has been up long enough to read.
    vi.useFakeTimers();
    const { container, rerender } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          tools: [{ callId: "c1", name: "bash" }],
          activity: "Running a command",
        })}
      />,
    );
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent("Running a command");
    expect(live).toHaveClass("sr-only");

    rerender(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          tools: [{ callId: "c1", name: "bash", output: "ok" }],
          activity: "Checking the CI logs",
        })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(CAPTION_HOLD_MS);
    });
    expect(
      screen.getByText("Checking the CI logs").closest("p"),
    ).not.toHaveClass("sr-only");
    vi.useRealTimers();
  });

  it("keeps the opening sentence above the work and settles the reply IN PLACE", () => {
    // The reply being written is the same element as the answer it becomes:
    // the durable `text` replaces the draft's words in place (usually the
    // same words), the "still writing" mark goes, and nothing is swapped.
    // The opening sentence stays above the work (live only: history has no
    // deltas, so a reload shows the work and the answer).
    const { container, rerender } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: false,
          lead: "Let me check the logs.",
          tools: [{ callId: "c1", name: "bash", output: "ok" }],
          liveText: "CI passed",
        })}
      />,
    );
    const draft = screen.getByText("CI passed").closest("[data-slot='bubble']");
    expect(draft).toHaveAttribute("data-draft");

    rerender(
      <TurnBlock
        turn={turn({ status: "done" })}
        rendered={rendered({
          ended: true,
          text: "CI passed; nothing to do.",
          lead: "Let me check the logs.",
          tools: [{ callId: "c1", name: "bash", output: "ok" }],
        })}
      />,
    );
    const answer = screen
      .getByText("CI passed; nothing to do.")
      .closest("[data-slot='bubble']");
    expect(answer).toBe(draft);
    expect(answer).not.toHaveAttribute("data-draft");
    expect(container.querySelector("[data-draft]")).toBeNull();
    expect(screen.getByText("Let me check the logs.")).toBeInTheDocument();
  });

  it("settles a reply with no tools in place too, and never shows a repeated lead twice", () => {
    const { rerender } = render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({ ended: false, liveText: "It is 4" })}
      />,
    );
    const draft = screen.getByText("It is 4").closest("[data-slot='bubble']");
    rerender(
      <TurnBlock
        turn={turn({ status: "done" })}
        rendered={rendered({ text: "It is 4." })}
      />,
    );
    expect(screen.getByText("It is 4.").closest("[data-slot='bubble']")).toBe(
      draft,
    );

    // A turn stopped mid-tool keeps its last words as the answer: when
    // those are the opening sentence, they show once.
    render(
      <TurnBlock
        turn={turn({ id: "t2", status: "aborted" })}
        rendered={rendered({
          turnId: "t2",
          lead: "Checking the deploy.",
          text: "Checking the deploy.",
          tools: [{ callId: "c1", name: "bash" }],
        })}
      />,
    );
    expect(screen.getAllByText("Checking the deploy.")).toHaveLength(1);
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
    // The stream says the turn is over: no caption claims it is thinking.
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("never says Thinking… after Stop while the poll catches up", () => {
    // After Stop the stream ends the turn before the poll flips it to
    // aborted; falling back to "Thinking…" in between would read as the
    // agent starting again.
    render(
      <TurnBlock
        turn={turn({ status: "running" })}
        rendered={rendered({
          ended: true,
          tools: [{ callId: "c1", name: "bash" }],
        })}
      />,
    );
    expect(screen.queryByText("Thinking…")).toBeNull();
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

  it("says thinking from the first beat, whatever the lifecycle: a waking machine is never announced", () => {
    const { rerender } = render(
      <TurnBlock turn={turn({ status: "queued" })} rendered={undefined} />,
    );
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.queryByText(/waking/i)).toBeNull();
    // The lifecycle still rides the line for support, as data, never copy.
    expect(screen.getByText("Thinking…").closest("p")).toHaveAttribute(
      "data-turn-status",
      "queued",
    );

    rerender(
      <TurnBlock turn={turn({ status: "running" })} rendered={undefined} />,
    );
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.getByText("Thinking…").closest("p")).toHaveAttribute(
      "data-turn-status",
      "running",
    );
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

  it("renders a wake that JOINED the turn as a system label, never a user bubble", () => {
    // A wake joining a running wake rides as a follow-up row; it is the
    // platform's instruction, so it gets the same quiet header a standalone
    // delivery does. MUTATION-PROOF: render every follow-up as <UserBubble>
    // and the "via watch" chip and a second end-aligned bubble reappear.
    const { container } = render(
      <TurnBlock
        turn={turn({ source: "watch", message: 'Watch on "tests"' })}
        rendered={rendered({ text: "Both runs passed." })}
        followUps={[
          turn({
            id: "f1",
            status: "joined",
            source: "watch",
            message: 'Watch on "lint"',
            followUpOfTurnId: "t1",
          }),
        ]}
      />,
    );
    expect(screen.getByText('Watch on "lint"')).toBeInTheDocument();
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

describe("the onboarding agent's greeting turn", () => {
  const greeting = (overrides: Partial<Turn> = {}) =>
    turn({
      source: "greeting",
      message: "This is the very first message… (the platform's brief)",
      ...overrides,
    });

  it("shows the agent's own reply as a normal answer, never the brief", () => {
    render(
      <TurnBlock
        turn={greeting()}
        rendered={rendered({ text: "Hi Alex, I'm Donna. What's your name?" })}
      />,
    );
    expect(
      screen.getByText("Hi Alex, I'm Donna. What's your name?"),
    ).toBeInTheDocument();
    // The brief is plumbing: no user bubble, no header.
    expect(screen.queryByText(/platform's brief/)).toBeNull();
    expect(screen.getByTestId("greeting-actions")).toBeInTheDocument();
  });

  it("holds the Gmail card until the agent's words have landed", () => {
    render(
      <TurnBlock
        turn={greeting({ status: "running" })}
        rendered={rendered({ ended: false })}
      />,
    );
    expect(screen.queryByTestId("greeting-actions")).toBeNull();
  });

  it("still offers the first step under a greeting the agent could not answer", () => {
    // No words are invented for the agent: the failure reads as the
    // product's notice, and connecting Gmail stays one click away.
    // MUTATION-PROOF: render the actions only beside the answer text and
    // this row loses its card.
    render(
      <TurnBlock
        turn={greeting({
          status: "failed",
          error: "The agent couldn't start. Try again in a moment.",
        })}
        rendered={undefined}
      />,
    );
    expect(
      screen.getByText("The agent couldn't start. Try again in a moment."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("greeting-actions")).toBeInTheDocument();
  });

  it("never adds the card to an ordinary turn", () => {
    render(<TurnBlock turn={turn()} rendered={rendered({ text: "Done." })} />);
    expect(screen.queryByTestId("greeting-actions")).toBeNull();
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

  it.each([
    ["model_refused", MODEL_REFUSED_MESSAGE],
    ["model_empty_response", MODEL_EMPTY_RESPONSE_MESSAGE],
  ])(
    "an unanswered turn (%s) reads as its notice under the message, never an empty bubble",
    (errorCode, message) => {
      // The exact row the control plane stores, with the transcript the run
      // left: started and a clean end, no text, no error event. Not a key
      // problem, so no Models-page door; the sentence itself says what to do.
      render(
        <TurnBlock
          turn={turn({ status: "failed", error: message, errorCode })}
          rendered={rendered({ text: "", ended: true })}
          modelsHref="/w/p1/agents/a1/models"
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(message);
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.queryByText(/stop_reason|guardrail/)).toBeNull();
    },
  );

  it("the SAME turn closed `done` (the old outcome) renders nothing at all", () => {
    // The before-state the fix exists for: a done turn with no words shows
    // no reply and no notice. Kept as a pin so the failed close stays the
    // only way a refusal becomes visible.
    const { container } = render(
      <TurnBlock
        turn={turn({ status: "done" })}
        rendered={rendered({ text: "", ended: true })}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(container).not.toHaveTextContent(/declined|empty answer/);
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
  });

  // Every failure is guidance with the sentence it carries, whatever its
  // code (or none): a lifecycle hiccup, a gateway refusal with no one-click
  // fix, or an uncoded readable sentence. None gets an action, and none is
  // painted as a crash.
  it.each([
    ["agent_restarted", "The agent had to restart while working on this."],
    ["agent_start_failed", "The agent couldn't start."],
    ["at_capacity", "Too many agents are running right now."],
    ["image_unavailable", "Its software isn't installed yet."],
    ["turn_stalled", "The agent stopped responding."],
    ["turn_time_limit", "This turn reached its time limit."],
    ["blocked_by_policy", "A OneCLI policy stopped this request."],
    ["gateway_unavailable", "OneCLI couldn't reach the model provider."],
    ["home_read_only", "The agent hit a storage problem and is restarting."],
    ["home_read_only_held", "The agent could not restart by itself."],
    [null, "harness event stream ended unexpectedly"],
  ])(
    "renders a %s failure as a notice with its own sentence",
    (errorCode, error) => {
      render(
        <TurnBlock
          turn={turn({ status: "failed", error, errorCode })}
          rendered={undefined}
          modelsHref="/w/p1/agents/a1/models"
        />,
      );
      // The POSITIVE pin: the notice treatment (role=status) with the text as
      // written, not merely the absence of red.
      expect(screen.getByRole("status")).toHaveTextContent(error);
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(document.querySelector(".text-destructive")).toBeNull();
    },
  );

  // The gateway said the workspace holds a key this agent was not given.
  // The fix is attaching it on the Models page, so the notice links there
  // (never the add-key dialog: adding a second key is not the fix), and the
  // raw gateway body stays folded away.
  it("offers Attach the key for model_key_not_attached, with the raw body folded", async () => {
    const user = userEvent.setup();
    const onConnectModelKey = vi.fn();
    const raw =
      'Anthropic API error (401 Unauthorized): {"error":"access_restricted","message":"attach the key"}';
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: "This agent doesn't have access to your model key yet.",
          errorCode: "model_key_not_attached",
        })}
        rendered={rendered({ error: raw })}
        modelsHref="/w/p1/agents/a1/models"
        onConnectModelKey={onConnectModelKey}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Attach the key" }),
    ).toHaveAttribute("href", "/w/p1/agents/a1/models");
    expect(screen.queryByText(/access_restricted/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByText(/access_restricted/).textContent).toBe(raw);
    expect(onConnectModelKey).not.toHaveBeenCalled();
  });

  // The agent HAS the key, but its saved value could not be read. The fix is
  // re-entering it on the Models page: never the add-key dialog, and never
  // a provider-refusal label that blames a usage limit.
  it("offers Re-enter the key for model_key_unreadable, never the add-key dialog", () => {
    const onConnectModelKey = vi.fn();
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: "OneCLI couldn't read this agent's saved model key.",
          errorCode: "model_key_unreadable",
        })}
        rendered={undefined}
        modelsHref="/w/p1/agents/a1/models"
        onConnectModelKey={onConnectModelKey}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Re-enter the key" }),
    ).toHaveAttribute("href", "/w/p1/agents/a1/models");
    expect(screen.queryByRole("button", { name: /key/i })).toBeNull();
    expect(onConnectModelKey).not.toHaveBeenCalled();
  });

  it("keeps a policy refusal's raw answer, which names the rule, one click away", async () => {
    const user = userEvent.setup();
    const raw =
      'API Error: 403 {"error":"blocked_by_policy","message":"Blocked by OneCLI policy rule \\"No weekend calls\\"."}';
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: "A OneCLI policy or spending limit stopped this request.",
          errorCode: "blocked_by_policy",
        })}
        rendered={rendered({ error: raw })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByText(/No weekend calls/).textContent).toBe(raw);
  });

  // An uncoded failure that carries a provider's raw response body: nothing
  // classified it, so no fix is offered, but the reader never gets the blob
  // as the message.
  const RAW_PROVIDER_ERROR =
    'Claude API error (500 Internal Server Error): {"type":"error","error":{"type":"api_error","message":"Internal server error"}}';

  it("folds an uncoded raw provider body behind Technical details", async () => {
    const user = userEvent.setup();
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error: RAW_PROVIDER_ERROR,
          errorCode: null,
        })}
        rendered={undefined}
        modelsHref="/w/p1/agents/a1/models"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "The agent ran into an error and couldn't finish this message.",
    );
    // Nothing classified it, so no key fix is claimed.
    expect(screen.queryByRole("link")).toBeNull();
    // Collapsed: the blob is not on screen until asked for.
    const trigger = screen.getByRole("button", { name: "Technical details" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Internal Server Error/)).toBeNull();

    await user.click(trigger);
    const details = screen.getByText(/Internal Server Error/);
    expect(details.textContent).toBe(RAW_PROVIDER_ERROR);
    // Outside the live region: expanding never reads the blob aloud.
    expect(screen.getByRole("status")).not.toContainElement(details);
  });

  it("folds the stream's raw error too, once the turn settles", () => {
    // The uncoded harness failure's usual shape: turn.error is NULL and the
    // transcript's error event is the only witness.
    render(
      <TurnBlock
        turn={turn({ status: "failed", error: null })}
        rendered={rendered({ error: RAW_PROVIDER_ERROR })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "The agent ran into an error and couldn't finish this message.",
    );
    expect(
      screen.getByRole("button", { name: "Technical details" }),
    ).toBeInTheDocument();
  });

  it("renders the payload as text, never as markup", async () => {
    const user = userEvent.setup();
    render(
      <TurnBlock
        turn={turn({
          status: "failed",
          error:
            'Claude API error (502 Bad Gateway): <html><body><script>alert(1)</script><img src=x onerror="alert(2)"></body></html>',
        })}
        rendered={undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByText(/502 Bad Gateway/).textContent).toContain(
      "<script>alert(1)</script>",
    );
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
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
    // The card under an answer is the rows alone: the agent's sentence
    // introduces it, so no consent line.
    expect(screen.queryByText(/Only this agent gets access/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Connect Gmail" }),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain("connections?connect");
  });

  it("renders the connect card from a request_app_connection result even when the answer carries no link", () => {
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
    render(
      <QueryClientProvider client={queryClient}>
        <TurnBlock
          turn={turn()}
          rendered={rendered({
            text: "Jira isn't connected yet. Use the button below.",
            tools: [
              {
                callId: "c1",
                name: "mcp__onecli__request_app_connection",
                output: JSON.stringify({
                  status: "connect",
                  connectUrl:
                    "https://app.onecli.sh/w/a/connections?connect=jira&source=agent&agent_name=Arik&agent_id=agent%2D1",
                }),
              },
            ],
          })}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Connect Jira" }),
    ).toBeInTheDocument();
  });

  describe("the agent's files (send_file)", () => {
    it("renders outbound files under the AGENT's answer and inbound files under the PERSON's bubble — never mixed", () => {
      const { container } = withQuery(
        <TurnBlock
          turn={turn({
            attachments: [
              {
                id: "in-1",
                name: "brief.txt",
                mimeType: "text/plain",
                sizeBytes: 2048,
                status: "bound",
                direction: "inbound",
              },
              {
                id: "out-1",
                name: "clip.webm",
                mimeType: "video/webm",
                sizeBytes: 3 * 1024 * 1024,
                status: "bound",
                direction: "outbound",
                caption: "the run, recorded",
              },
            ],
          })}
          rendered={rendered({ text: "Recorded it." })}
        />,
      );
      const personSide = container.querySelector('[data-align="end"]');
      const agentSide = container.querySelector('[data-align="start"]');
      expect(personSide?.textContent).toContain("brief.txt");
      expect(personSide?.textContent).not.toContain("clip.webm");
      expect(agentSide?.textContent).toContain("Recorded it.");
      expect(agentSide?.textContent).toContain("clip.webm");
      expect(agentSide?.textContent).not.toContain("brief.txt");
      expect(
        screen.getByRole("button", { name: "Preview clip.webm" }),
      ).toBeInTheDocument();
    });

    it("an older API's rows (no direction) all belong to the person", () => {
      const { container } = withQuery(
        <TurnBlock
          turn={turn({
            attachments: [
              {
                id: "in-1",
                name: "legacy.pdf",
                mimeType: "application/pdf",
                sizeBytes: 10,
                status: "bound",
              },
            ],
          })}
          rendered={rendered({ text: "ok" })}
        />,
      );
      // A PDF tile shows its page, not its name: find it by its label.
      const tile = '[aria-label="Preview legacy.pdf"]';
      expect(
        container.querySelector(`[data-align="end"] ${tile}`),
      ).not.toBeNull();
      expect(
        container.querySelector(`[data-align="start"] ${tile}`),
      ).toBeNull();
    });

    it("an expired file (retention took the bytes) is a quiet inert chip: named, struck, not a button, never previewed", () => {
      const { container } = withQuery(
        <TurnBlock
          turn={turn({
            attachments: [
              {
                id: "out-old",
                // An IMAGE type: the expired branch must win over the
                // thumbnail branch, or the thumb would fetch a 410.
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 10,
                status: "expired",
                direction: "outbound",
              },
            ],
          })}
          rendered={rendered({ text: "Here." })}
        />,
      );
      const agentSide = container.querySelector('[data-align="start"]');
      expect(agentSide?.textContent).toContain("shot.png");
      expect(agentSide?.textContent).toContain("expired");
      expect(
        screen.queryByRole("button", { name: "Preview shot.png" }),
      ).toBeNull();
      expect(container.querySelector("img")).toBeNull();
      expect(
        screen.getByTitle("This file expired after 30 days"),
      ).toBeInTheDocument();
    });

    it("a turn whose only output is a file still renders the agent block (no answer text)", () => {
      withQuery(
        <TurnBlock
          turn={turn({
            attachments: [
              {
                id: "out-1",
                name: "report.pdf",
                mimeType: "application/pdf",
                sizeBytes: 10,
                status: "bound",
                direction: "outbound",
              },
            ],
          })}
          rendered={undefined}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Preview report.pdf" }),
      ).toBeInTheDocument();
    });
  });
});
