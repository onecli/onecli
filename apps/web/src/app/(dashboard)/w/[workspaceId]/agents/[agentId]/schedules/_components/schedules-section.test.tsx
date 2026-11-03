// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCron } from "@/lib/api";

/**
 * The Schedules section, one describe per state the view can be in (the
 * channels-section pattern): empty, rows (incl. the paused and auto-disabled
 * shapes), and the actions. Hooks are mocked at the module seam; the API
 * client and the DB laws are covered elsewhere.
 */

const state = vi.hoisted(() => ({
  crons: [] as unknown[],
  isPending: false,
  isError: false,
  runNow: vi.fn(),
  update: vi.fn(),
  setEnabled: vi.fn(),
  evalSchedule: null as unknown,
  evalRuns: [] as unknown[],
  evalsError: false,
}));

vi.mock("@/hooks/use-crons", () => ({
  useCrons: () => ({
    data: state.isPending || state.isError ? undefined : { crons: state.crons },
    isPending: state.isPending,
    isError: state.isError,
  }),
  useCreateCron: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateCron: () => ({ mutate: state.update, isPending: false }),
  useSetCronEnabled: () => ({ mutate: state.setEnabled, isPending: false }),
  useRunCronNow: () => ({ mutate: state.runNow, isPending: false }),
  useDeleteCron: () => ({ mutate: vi.fn(), isPending: false }),
  useParseWords: () => ({ data: undefined, isFetching: false }),
}));

vi.mock("@/hooks/use-evals", () => ({
  useEvals: () => ({
    data: state.evalsError
      ? undefined
      : {
          questions: [],
          runs: state.evalRuns,
          schedule: state.evalSchedule,
        },
    isError: state.evalsError,
    refetch: vi.fn(),
  }),
  useSaveEvalSchedule: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEvalSchedule: () => ({ mutate: vi.fn(), isPending: false }),
  useStartEvalRun: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/ag-1/schedules",
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "ag-1", name: "andy", kind: "hosted" }),
}));

const { SchedulesSection } = await import("./schedules-section");

const cron = (overrides: Partial<AgentCron> = {}): AgentCron => ({
  id: "cr-1",
  agentId: "ag-1",
  name: "Daily inbox check",
  prompt: "check the inbox",
  schedule: "0 9 * * *",
  timezone: "America/Los_Angeles",
  gate: null,
  gateDescription: null,
  enabled: true,
  disabledReason: null,
  nextFireAt: "2026-08-08T09:00:00.000Z",
  lastFiredAt: null,
  lastOutcome: null,
  running: false,
  consecutiveFailures: 0,
  createdAt: "2026-08-07T00:00:00.000Z",
  ...overrides,
});

const renderSection = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SchedulesSection />
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.crons = [];
  state.isPending = false;
  state.isError = false;
  state.runNow.mockReset();
  state.update.mockReset();
  state.setEnabled.mockReset();
  state.evalSchedule = null;
  state.evalRuns = [];
  state.evalsError = false;
});
afterEach(cleanup);

describe("empty", () => {
  it("offers creation and points at the chat door", () => {
    renderSection();
    expect(screen.getByText("No schedules yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /New schedule/ }),
    ).toBeInTheDocument();
  });
});

describe("rows", () => {
  it("renders the schedule in plain words, its zone, and the pause switch AS the status", () => {
    state.crons = [cron()];
    renderSection();
    expect(screen.getByText("Daily inbox check")).toBeInTheDocument();
    // Plain words; the expression and zone stay one hover away.
    expect(screen.getByText("Every day at 09:00")).toHaveAttribute(
      "title",
      "0 9 * * * · America/Los_Angeles",
    );
    // A table: one header row names the columns every row lines up under.
    for (const column of ["Name", "When", "Next run", "Last run"]) {
      expect(screen.getByText(column)).toBeInTheDocument();
    }
    const toggle = screen.getByRole("switch", {
      name: "Pause Daily inbox check",
    });
    expect(toggle).toBeChecked();
    expect(screen.queryByText(/Auto-disabled/)).not.toBeInTheDocument();
  });

  it("a paused row reads Paused and offers Resume; Run now is frozen", () => {
    state.crons = [cron({ enabled: false })];
    renderSection();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Resume Daily inbox check" }),
    ).not.toBeChecked();
    expect(screen.getByRole("button", { name: /Run now/ })).toBeDisabled();
  });

  it("an auto-disabled row carries the ONE badge the switch cannot express", () => {
    state.crons = [
      cron({ enabled: false, disabledReason: "failures" }),
      cron({
        id: "cr-2",
        name: "Other",
        enabled: false,
        disabledReason: "authorization",
      }),
    ];
    renderSection();
    expect(screen.getByText(/Auto-disabled: kept failing/)).toBeInTheDocument();
    expect(
      screen.getByText(/Auto-disabled: creator lost access/),
    ).toBeInTheDocument();
  });

  it("a finished one-shot reads 'Already ran', with its time in words", () => {
    state.crons = [
      cron({
        schedule: "2026-08-25T14:00:00",
        enabled: false,
        disabledReason: "completed",
        lastFiredAt: "2026-08-25T14:00:01.000Z",
        lastOutcome: "ok",
      }),
    ];
    renderSection();
    // Next run says it is done; When reads as a date, never the raw ISO
    // string; the destructive auto-disabled copy (a lie for a schedule that
    // ran its course) is absent, and so is Paused.
    expect(screen.getByText("Already ran")).toBeInTheDocument();
    expect(screen.getByText(/^Once, Aug 25/)).toBeInTheDocument();
    expect(screen.queryByText("2026-08-25T14:00:00")).not.toBeInTheDocument();
    expect(screen.queryByText(/Auto-disabled/)).not.toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });

  it("a live run reads 'Running now' and blocks Run now, whatever the last outcome was", () => {
    // `running` is the server's derived fact; the last outcome under it
    // (here a skip, booked while this run was live) never hides it.
    state.crons = [
      cron({
        running: true,
        lastOutcome: "skipped_busy",
        lastFiredAt: "2026-08-08T09:00:00.000Z",
      }),
    ];
    renderSection();
    expect(screen.getByText("Running now")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run now/ })).toBeDisabled();
  });

  it("a run a person stopped reads 'Stopped', not as a failure", () => {
    state.crons = [
      cron({
        lastOutcome: "stopped",
        lastFiredAt: "2026-08-08T09:00:00.000Z",
      }),
    ];
    renderSection();
    expect(screen.getByText(/^Stopped, /)).toBeInTheDocument();
    expect(screen.queryByText("Running now")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Last run failed")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Last run was stopped")).toBeInTheDocument();
  });
});

describe("actions", () => {
  it("editing a one-shot round-trips through the Once preset", async () => {
    state.crons = [cron({ schedule: "2026-08-25T14:00:00" })];
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "More for Daily inbox check" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    // presetOf detected the ISO shape: the datetime input is seeded from the
    // stored expression (minutes precision — datetime-local's grain).
    const onceInput = screen.getByLabelText("On");
    expect(onceInput).toHaveValue("2026-08-25T14:00");
    // Save serializes back to croner's fire-once pattern, seconds restored.
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(state.update).toHaveBeenCalledWith(
      {
        cronId: "cr-1",
        input: expect.objectContaining({ schedule: "2026-08-25T14:00:00" }),
      },
      expect.anything(),
    );
  });

  it("Run now force-fires through the mutation", async () => {
    state.crons = [cron()];
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: /Run now/ }));
    expect(state.runNow).toHaveBeenCalledWith("cr-1", expect.anything());
  });

  it("the pause switch writes enabled:false through the instant toggle", async () => {
    state.crons = [cron()];
    renderSection();
    await userEvent.click(
      screen.getByRole("switch", { name: "Pause Daily inbox check" }),
    );
    expect(state.setEnabled).toHaveBeenCalledWith({
      cronId: "cr-1",
      enabled: false,
    });
  });

  it("New schedule opens the dialog with the browser timezone pre-filled", async () => {
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: /New schedule/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const tz = screen.getByLabelText("Timezone") as HTMLInputElement;
    expect(tz.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("the eval schedule", () => {
  const evalSchedule = {
    schedule: "0 9 * * *",
    timezone: "Asia/Jerusalem",
    enabled: true,
    disabledReason: null,
    nextFireAt: "2026-10-12T06:00:00.000Z",
    lastFiredAt: null,
    lastOutcome: "started",
  };

  it("is listed with the agent's schedules, with the cron row's controls", () => {
    state.evalSchedule = evalSchedule;
    renderSection();
    expect(screen.queryByText("No schedules yet")).not.toBeInTheDocument();
    expect(screen.getByText("Run evals")).toBeInTheDocument();
    // Same words as the cron rows beside it (one describer).
    expect(screen.getByText("Every day at 09:00")).toHaveAttribute(
      "title",
      "Asia/Jerusalem",
    );
    expect(screen.getByText("Never yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More for Run evals" }),
    ).toBeInTheDocument();
    // The same controls as a cron row; with no crons there are no cron
    // runs to open.
    expect(
      screen.getByRole("switch", { name: "Pause Run evals" }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: /Run now/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Run history/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /New schedule/ }),
    ).toBeInTheDocument();
  });

  it("sits alongside the crons, under one link to all of the scheduled runs", () => {
    state.evalSchedule = evalSchedule;
    state.crons = [cron(), cron({ id: "cr-2", name: "Weekly digest" })];
    renderSection();
    expect(screen.getByText("Run evals")).toBeInTheDocument();
    expect(screen.getByText("Daily inbox check")).toBeInTheDocument();
    const runs = screen.getAllByRole("link", { name: /Run history/ });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveAttribute(
      "href",
      "/w/ws-1/activity?tab=runs&agent=ag-1&view=cron",
    );
  });

  it("shows its newest run: running now, then the time it finished", () => {
    state.evalSchedule = evalSchedule;
    const run = {
      id: "run-1",
      status: "running",
      createdAt: "2026-10-12T06:03:00.000Z",
      finishedAt: null,
    };
    state.evalRuns = [run];
    const { unmount } = renderSection();
    expect(screen.getByText("Running now").closest("a")).toHaveAttribute(
      "href",
      "/w/ws-1/agents/ag-1/evals",
    );
    unmount();

    state.evalRuns = [
      { ...run, status: "done", finishedAt: "2026-10-12T06:05:00.000Z" },
    ];
    renderSection();
    expect(screen.queryByText("Running now")).not.toBeInTheDocument();
    expect(screen.queryByText("Never yet")).not.toBeInTheDocument();
  });

  it("says why the platform paused it", () => {
    state.evalSchedule = {
      ...evalSchedule,
      enabled: false,
      disabledReason: "authorization",
    };
    renderSection();
    expect(screen.getByText("Paused")).toHaveAttribute(
      "title",
      expect.stringMatching(/no longer has access/),
    );
  });

  it("an evals failure never hides the crons", () => {
    state.evalsError = true;
    state.crons = [cron()];
    renderSection();
    expect(screen.getByText("Daily inbox check")).toBeInTheDocument();
    expect(screen.queryByText("Run evals")).not.toBeInTheDocument();
  });
});

describe("rows in plain words", () => {
  it("marks a conditional schedule with an icon, and keeps an expression it cannot say plainly", () => {
    state.crons = [
      cron({
        id: "cr-g",
        name: "Deck watcher",
        schedule: "*/30 * * * *",
        gate: "bash deck.sh",
        gateDescription: "a new board deck appears",
      }),
      cron({ id: "cr-m", name: "Yearly", schedule: "0 9 1 1 *" }),
    ];
    renderSection();
    expect(screen.getByText("Every 30 minutes")).toBeInTheDocument();
    // A badge, not a sentence: the condition itself is in its tooltip.
    expect(screen.getByLabelText("Conditional")).toBeInTheDocument();
    expect(
      screen.queryByText(/a new board deck appears/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("0 9 1 1 *")).toBeInTheDocument();
  });
});
