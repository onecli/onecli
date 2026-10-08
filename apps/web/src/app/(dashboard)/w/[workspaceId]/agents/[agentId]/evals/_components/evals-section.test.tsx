// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalQuestion, EvalRunSummary, EvalsView } from "@/lib/api";

/**
 * The Evals section's states and its page-level wiring. The data hooks are
 * mocked at the module seam; the results card, the dialog and the run
 * sheet are stubbed (each has its own suite).
 */

const state = vi.hoisted(() => ({
  view: undefined as EvalsView | undefined,
  isPending: false,
  isError: false,
  start: vi.fn(),
  startPending: false,
  archive: vi.fn(),
  dialog: vi.fn(),
  results: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-evals", () => ({
  useEvals: () => ({
    data: state.view,
    isPending: state.isPending,
    isError: state.isError,
  }),
  useStartEvalRun: () => ({
    mutate: state.start,
    isPending: state.startPending,
  }),
  useArchiveEvalQuestion: () => ({ mutate: state.archive, isPending: false }),
}));
vi.mock("@/lib/api/policy-visibility", () => ({
  useEffectiveCredentials: () => ({
    data: undefined,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "ag-1", name: "andy", kind: "hosted" }),
}));
vi.mock("@/lib/agents/runs", () => ({ RunDetailSheet: () => null }));
vi.mock("./question-dialog", () => ({
  QuestionDialog: (props: { state: { open: boolean; editing: unknown } }) => {
    state.dialog(props.state);
    return null;
  },
}));
vi.mock("./run-results", () => ({
  RunResults: (props: { runId: string }) => {
    state.results(props.runId);
    return <p>Results of {props.runId}</p>;
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: state.toastError },
}));

const { EvalsSection } = await import("./evals-section");

const question = (
  id: string,
  patch: Partial<EvalQuestion> = {},
): EvalQuestion => ({
  id,
  question: `Question ${id}`,
  expected: "42",
  kind: "numeric",
  expectedApps: [],
  ...patch,
});

const runSummary = (
  id: string,
  patch: Partial<EvalRunSummary> = {},
): EvalRunSummary => ({
  id,
  status: "done",
  configVersion: "cfg",
  total: 1,
  counts: { pending: 0, passed: 1, mismatch: 0, error: 0, inconclusive: 0 },
  error: null,
  createdAt: "2026-10-07T10:00:00Z",
  startedAt: null,
  finishedAt: null,
  ...patch,
});

const view = (patch: Partial<EvalsView> = {}): EvalsView => ({
  questions: [],
  runs: [],
  maxQuestions: 50,
  ...patch,
});

beforeEach(() => {
  state.view = undefined;
  state.isPending = false;
  state.isError = false;
  state.startPending = false;
  state.start.mockReset();
  state.archive.mockReset();
  state.dialog.mockReset();
  state.results.mockReset();
  // Radix Select measures and captures the pointer; jsdom does neither.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
});
afterEach(() => cleanup());

const runButton = () =>
  screen.getByRole("button", { name: /Run tests|Running tests/ });

describe("EvalsSection", () => {
  it("shows a loading state, then an error state", () => {
    state.isPending = true;
    const { rerender } = render(<EvalsSection />);
    expect(screen.getByText("Loading evals")).toBeInTheDocument();

    state.isPending = false;
    state.isError = true;
    rerender(<EvalsSection />);
    expect(screen.getByRole("alert")).toHaveTextContent("Evals failed to load");
  });

  it("starts empty: no results, questions open, and nothing to run", () => {
    state.view = view();
    render(<EvalsSection />);
    expect(screen.getByText("No results yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Add a test question below, then run your tests/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Add a question you know the answer to/),
    ).toBeVisible();
    expect(runButton()).toBeDisabled();
  });

  it("opens the dialog to add a question, and to edit one", async () => {
    state.view = view({ questions: [question("q-1")] });
    const user = userEvent.setup();
    render(<EvalsSection />);

    await user.click(screen.getByRole("button", { name: "Add question" }));
    expect(state.dialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, editing: null }),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit test question: Question q-1" }),
    );
    expect(state.dialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        open: true,
        editing: expect.objectContaining({ id: "q-1" }),
      }),
    );
  });

  it("stops adding at the question limit", () => {
    state.view = view({
      questions: [question("q-1"), question("q-2")],
      maxQuestions: 2,
    });
    render(<EvalsSection />);
    expect(screen.getByRole("button", { name: "Add question" })).toBeDisabled();
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("leads with the latest run and folds the questions once runs exist", () => {
    state.view = view({
      questions: [question("q-1")],
      runs: [runSummary("run-2"), runSummary("run-1")],
    });
    render(<EvalsSection />);
    expect(screen.getByText("Results of run-2")).toBeInTheDocument();
    expect(screen.queryByText("Question q-1")).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Test run" }),
    ).toBeInTheDocument();
  });

  it("runs the tests, and blocks a second run while one is active", async () => {
    state.view = view({ questions: [question("q-1")] });
    const user = userEvent.setup();
    const { rerender } = render(<EvalsSection />);

    await user.click(runButton());
    expect(state.start).toHaveBeenCalledTimes(1);

    state.view = view({
      questions: [question("q-1")],
      runs: [runSummary("run-1", { status: "running" })],
    });
    rerender(<EvalsSection />);
    expect(runButton()).toBeDisabled();
    expect(runButton()).toHaveTextContent("Running tests…");
  });

  it("says why a run could not start", async () => {
    state.view = view({ questions: [question("q-1")] });
    state.start.mockImplementation(
      (_: undefined, options: { onError: (error: Error) => void }) =>
        options.onError(new Error("A test run is already in progress")),
    );
    const user = userEvent.setup();
    render(<EvalsSection />);

    await user.click(runButton());
    expect(state.toastError).toHaveBeenCalledWith(
      "A test run is already in progress",
    );
  });

  it("picks an earlier run from the history", async () => {
    state.view = view({
      questions: [question("q-1")],
      runs: [runSummary("run-2"), runSummary("run-1", { status: "failed" })],
    });
    const user = userEvent.setup();
    render(<EvalsSection />);

    await user.click(screen.getByRole("combobox", { name: "Test run" }));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("latest");
    expect(options[1]).toHaveTextContent("stopped");
    await user.click(screen.getByRole("option", { name: /stopped/ }));
    expect(screen.getByText("Results of run-1")).toBeInTheDocument();
  });

  it("archives a question only after confirmation", async () => {
    state.view = view({ questions: [question("q-1")] });
    const user = userEvent.setup();
    render(<EvalsSection />);

    await user.click(
      screen.getByRole("button", {
        name: "Archive test question: Question q-1",
      }),
    );
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveTextContent("Results of past runs are kept");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state.archive).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", {
        name: "Archive test question: Question q-1",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(state.archive).toHaveBeenCalledWith("q-1", expect.anything());
  });
});
