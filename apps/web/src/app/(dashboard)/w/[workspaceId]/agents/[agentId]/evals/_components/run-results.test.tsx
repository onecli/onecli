// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalResultView } from "@onecli/api/validations/evals";
import type { EvalRunDetail } from "@/lib/api";

/** One run's results through the real polling hook (API client mocked). */

const api = vi.hoisted(() => ({ getRun: vi.fn() }));
vi.mock("@/lib/api", () => ({ evals: { getRun: api.getRun } }));

const { RunResults } = await import("./run-results");

const result = (patch: Partial<EvalResultView> = {}): EvalResultView => ({
  questionId: "q-pass",
  question: "How many customers?",
  expected: "42",
  kind: "numeric",
  expectedApps: [],
  outcome: "passed",
  answer: "We have 42 customers.",
  missingApps: [],
  turnId: "turn-pass",
  conversationId: "conv-pass",
  error: null,
  change: "same",
  ...patch,
});

const run = (patch: Partial<EvalRunDetail> = {}): EvalRunDetail => ({
  id: "run-1",
  status: "done",
  configVersion: "cfg-2",
  total: 2,
  counts: { pending: 0, passed: 1, mismatch: 1, error: 0, inconclusive: 0 },
  error: null,
  createdAt: "2026-10-07T10:00:00Z",
  startedAt: "2026-10-07T10:00:01Z",
  finishedAt: "2026-10-07T10:01:00Z",
  results: [
    result(),
    result({
      questionId: "q-broke",
      question: "Who renewed?",
      expected: "Acme",
      kind: "text",
      outcome: "mismatch",
      answer: "Nobody renewed.",
      turnId: "turn-broke",
      change: "regressed",
      expectedApps: ["gmail", "host:crm.example.com"],
      missingApps: ["host:crm.example.com"],
    }),
  ],
  previous: { id: "run-0", configVersion: "cfg-1" },
  ...patch,
});

const labels: Record<string, string> = {
  gmail: "Gmail",
  "host:crm.example.com": "CRM",
};

const mount = (editable: string[] = ["q-pass", "q-broke"]) => {
  const onInspect = vi.fn();
  const onEdit = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RunResults
        agentId="ag-1"
        runId="run-1"
        appLabel={(id) => labels[id] ?? id}
        editableQuestionIds={new Set(editable)}
        onInspect={onInspect}
        onEdit={onEdit}
      />
    </QueryClientProvider>,
  );
  return { onInspect, onEdit };
};

beforeEach(() => api.getRun.mockReset());
afterEach(() => cleanup());

describe("RunResults", () => {
  it("lists what broke first, with the expected answer beside the agent's", async () => {
    api.getRun.mockResolvedValue(run());
    mount();
    const list = await screen.findByRole("list", { name: "Results" });
    const [first, second] = [...list.children].map((item) =>
      item instanceof HTMLElement ? item : null,
    );

    expect(first).toHaveTextContent("Who renewed?");
    expect(first).toHaveTextContent("Broke since last run");
    expect(
      within(first ?? list).getByRole("img", { name: "Mismatch" }),
    ).toBeInTheDocument();
    expect(first).toHaveTextContent("Nobody renewed.");
    expect(second).toHaveTextContent("How many customers?");
    expect(api.getRun).toHaveBeenCalledWith("ag-1", "run-1");
  });

  it("says which required apps were reached, in words, not color alone", async () => {
    api.getRun.mockResolvedValue(run());
    mount();
    await screen.findByRole("list", { name: "Results" });
    expect(screen.getByText("Gmail").parentElement).toHaveTextContent(
      "Gmailreached",
    );
    expect(screen.getByText("CRM").parentElement).toHaveTextContent(
      "CRMnot reached",
    );
  });

  it("offers editing only for questions that still exist, and inspects by turn", async () => {
    api.getRun.mockResolvedValue(run());
    const { onInspect, onEdit } = mount(["q-pass"]);
    const user = userEvent.setup();
    await screen.findByRole("list", { name: "Results" });

    expect(
      screen.queryByRole("button", {
        name: "Edit test question: Who renewed?",
      }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", {
        name: "Edit test question: How many customers?",
      }),
    );
    expect(onEdit).toHaveBeenCalledWith("q-pass");
    await user.click(
      screen.getByRole("button", { name: "Inspect run: Who renewed?" }),
    );
    expect(onInspect).toHaveBeenCalledWith("turn-broke");
  });

  it("shows a stopped run's reason", async () => {
    api.getRun.mockResolvedValue(
      run({ status: "failed", error: "The agent is unavailable" }),
    );
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This run stopped early: The agent is unavailable",
    );
  });

  it("polls an active run until it settles, then stops", async () => {
    vi.useFakeTimers();
    try {
      api.getRun
        .mockResolvedValueOnce(
          run({
            status: "running",
            counts: {
              pending: 1,
              passed: 1,
              mismatch: 0,
              error: 0,
              inconclusive: 0,
            },
            results: [result()],
          }),
        )
        .mockResolvedValue(run());
      mount();
      await act(() => vi.advanceTimersByTimeAsync(10));
      expect(screen.getByRole("status")).toHaveTextContent("Asking 2 of 2");
      expect(screen.getByText("1 more question waiting")).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(2_010));
      expect(api.getRun).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("status")).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(api.getRun).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the answer as text, never as markup", async () => {
    api.getRun.mockResolvedValue(
      run({
        results: [result({ answer: '<img src=x onerror="alert(1)">' })],
        total: 1,
        counts: {
          pending: 0,
          passed: 1,
          mismatch: 0,
          error: 0,
          inconclusive: 0,
        },
      }),
    );
    mount();
    expect(
      await screen.findByText('<img src=x onerror="alert(1)">'),
    ).toBeInTheDocument();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("calls an unfinished question 'did not finish', never a mismatch, and cannot inspect a turn that never started", async () => {
    api.getRun.mockResolvedValue(
      run({
        total: 1,
        counts: {
          pending: 0,
          passed: 0,
          mismatch: 0,
          error: 1,
          inconclusive: 0,
        },
        results: [
          result({
            outcome: "error",
            answer: null,
            turnId: null,
            error: "The agent did not answer in time",
          }),
        ],
      }),
    );
    mount();
    const list = await screen.findByRole("list", { name: "Results" });
    expect(
      within(list).getByRole("img", { name: "Did not finish" }),
    ).toBeInTheDocument();
    expect(within(list).queryByText("Mismatch")).toBeNull();
    expect(list).toHaveTextContent("The agent did not answer in time");
    expect(
      screen.getByRole("button", { name: "Inspect run: How many customers?" }),
    ).toBeDisabled();
  });

  it("keeps app checks neutral when the evidence could not be read", async () => {
    api.getRun.mockResolvedValue(
      run({
        total: 1,
        counts: {
          pending: 0,
          passed: 0,
          mismatch: 0,
          error: 0,
          inconclusive: 1,
        },
        results: [
          result({
            outcome: "inconclusive",
            expectedApps: ["gmail"],
            missingApps: null,
          }),
        ],
      }),
    );
    mount();
    await screen.findByRole("list", { name: "Results" });
    expect(screen.getByText("(could not be checked)")).toBeInTheDocument();
    expect(screen.getByText("Gmail").parentElement).toHaveTextContent(
      "Gmailnot checked",
    );
  });

  it("clips a long answer and lets it be read in full", async () => {
    const answer = `${"word ".repeat(80)}THE END`;
    api.getRun.mockResolvedValue(
      run({
        total: 1,
        counts: {
          pending: 0,
          passed: 1,
          mismatch: 0,
          error: 0,
          inconclusive: 0,
        },
        results: [result({ answer })],
      }),
    );
    mount();
    const user = userEvent.setup();
    const more = await screen.findByRole("button", { name: "Show more" });
    expect(screen.queryByText(/THE END/)).toBeNull();
    await user.click(more);
    expect(screen.getByText(/THE END/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
