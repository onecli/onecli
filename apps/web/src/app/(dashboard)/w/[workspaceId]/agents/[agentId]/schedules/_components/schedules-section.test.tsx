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
}));

vi.mock("@/hooks/use-crons", () => ({
  useCrons: () => ({
    data: state.isPending || state.isError ? undefined : { crons: state.crons },
    isPending: state.isPending,
    isError: state.isError,
  }),
  useCreateCron: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateCron: () => ({ mutate: state.update, isPending: false }),
  useRunCronNow: () => ({ mutate: state.runNow, isPending: false }),
  useDeleteCron: () => ({ mutate: vi.fn(), isPending: false }),
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
  enabled: true,
  disabledReason: null,
  nextFireAt: "2026-08-08T09:00:00.000Z",
  lastFiredAt: null,
  lastOutcome: null,
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
  it("renders the schedule with its expression, zone, and the pause switch AS the status", () => {
    state.crons = [cron()];
    renderSection();
    expect(screen.getByText("Daily inbox check")).toBeInTheDocument();
    expect(screen.getByText("0 9 * * *")).toBeInTheDocument();
    expect(screen.getByText("America/Los_Angeles")).toBeInTheDocument();
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

  it("a completed one-shot reads Completed — neutral, never Auto-disabled", () => {
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
    // Both the badge and the fire label say Completed; the destructive
    // auto-disabled copy (a lie for a schedule that ran its course) is absent,
    // and so is Paused.
    expect(screen.getAllByText("Completed").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Auto-disabled/)).not.toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });
});

describe("actions", () => {
  it("editing a one-shot round-trips through the Once preset", async () => {
    state.crons = [cron({ schedule: "2026-08-25T14:00:00" })];
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit Daily inbox check" }),
    );
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

  it("the pause switch writes enabled:false", async () => {
    state.crons = [cron()];
    renderSection();
    await userEvent.click(
      screen.getByRole("switch", { name: "Pause Daily inbox check" }),
    );
    expect(state.update).toHaveBeenCalledWith(
      { cronId: "cr-1", input: { enabled: false } },
      expect.anything(),
    );
  });

  it("New schedule opens the dialog with the browser timezone pre-filled", async () => {
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: /New schedule/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const tz = screen.getByLabelText("Timezone") as HTMLInputElement;
    expect(tz.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
