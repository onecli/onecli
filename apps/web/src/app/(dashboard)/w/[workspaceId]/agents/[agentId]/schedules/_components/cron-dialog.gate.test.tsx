// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentCron } from "@/lib/api";

/** The run condition through the real dialog. It is the agent's to set,
 * so a person never types a command: a new schedule points to the chat, a
 * gated one shows the check read-only, and the only edit is turning it off. */

// The real save settles; so does this one, or the next save is (rightly)
// ignored as a double submit.
const update = vi.fn((_args, handlers?: { onSuccess?: () => void }) =>
  handlers?.onSuccess?.(),
);
const create = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/ag-1/schedules",
  useRouter: () => ({ push }),
}));
const parsed = vi.hoisted(() => ({
  data: undefined as
    | undefined
    | { ok: true; schedule: string }
    | { ok: false; reason: string },
}));

vi.mock("@/hooks/use-crons", () => ({
  useCreateCron: () => ({ mutate: create, isPending: false }),
  useUpdateCron: () => ({ mutate: update, isPending: false }),
  useDeleteCron: () => ({ mutate: vi.fn(), isPending: false }),
  // The model fallback: whatever `parsed` holds, for whatever is asked.
  useParseWords: (_agentId: string, text: string | null) => ({
    data: text === null ? undefined : parsed.data,
    isFetching: false,
  }),
}));

const { CronDialog } = await import("./cron-dialog");

const cron: AgentCron = {
  id: "cr-1",
  agentId: "ag-1",
  name: "Deck watcher",
  prompt: "report new board decks",
  schedule: "0 9 * * *",
  timezone: "UTC",
  gate: "bash check-dropbox.sh",
  gateDescription: "a new board deck appears in Dropbox",
  enabled: true,
  disabledReason: null,
  nextFireAt: "2026-10-30T09:00:00.000Z",
  lastFiredAt: null,
  lastOutcome: null,
  running: false,
  consecutiveFailures: 0,
  createdAt: "2026-10-29T09:00:00.000Z",
};

afterEach(cleanup);

const renderWith = (editing: AgentCron | null) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CronDialog
        agentId="ag-1"
        open
        onOpenChange={vi.fn()}
        editing={editing}
      />
    </QueryClientProvider>,
  );

it("a new schedule asks the agent only once it has a name and a task, saving it first", async () => {
  const user = userEvent.setup();
  renderWith(null);
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByRole("textbox", { name: /check/i })).toBeNull();
  // An ungated schedule keeps the option folded under Advanced.
  expect(
    screen.queryByRole("button", { name: "Create & set up with agent" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: /Advanced/ }));
  const ask = screen.getByRole("button", {
    name: "Create & set up with agent",
  });
  expect(ask).toBeDisabled();

  await user.type(screen.getByLabelText("Name"), "Deck watcher");
  expect(ask).toBeDisabled();
  await user.type(
    screen.getByLabelText("What should it do?"),
    "report new board decks",
  );
  expect(ask).toBeEnabled();

  // Saved first, and once only, however fast the clicks; only once it
  // exists does the chat open on it (live, one click made two schedules).
  await user.dblClick(ask);
  expect(create).toHaveBeenCalledTimes(1);
  expect(push).not.toHaveBeenCalled();
  create.mock.calls[0]![1].onSuccess();
  expect(decodeURIComponent(push.mock.calls[0]![0])).toBe(
    '/w/ws-1/agents/ag-1/chat?draft=For the schedule "Deck watcher", only run it when ',
  );
});

it("a gated schedule shows its condition in plain words, changed through the agent", async () => {
  const user = userEvent.setup();
  renderWith(cron);
  const toggle = screen.getByRole("switch", { name: "Only run when" });
  expect(toggle).toBeChecked();
  expect(
    screen.getByText("a new board deck appears in Dropbox"),
  ).toBeInTheDocument();
  const change = screen.getByRole("link", { name: "Change" });
  // An absolute path to THIS agent's chat: the dialog is not a route, so a
  // relative link resolves against the workspace instead (the live bug).
  expect(decodeURIComponent(change.getAttribute("href") ?? "")).toBe(
    '/w/ws-1/agents/ag-1/chat?draft=For the schedule "Deck watcher", change when it runs.\nNow it only runs when: a new board deck appears in Dropbox\nChange it to only run when: ',
  );

  // An ordinary save never touches the check; switching it off removes it.
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(update.mock.calls.at(-1)?.[0].input).not.toHaveProperty("gate");
  await user.click(toggle);
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(update.mock.calls.at(-1)?.[0].input.gate).toBeNull();
});

it("When takes plain words, shows what it understood, and saves that cron", async () => {
  const user = userEvent.setup();
  renderWith({ ...cron, gate: null, gateDescription: null });
  const when = screen.getByLabelText("When");
  expect(when).toHaveValue("Every day at 09:00");

  await user.clear(when);
  await user.type(when, "every 5 minutes");
  expect(screen.getByText("✓ Every 5 minutes")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(update.mock.calls.at(-1)?.[0].input.schedule).toBe("*/5 * * * *");

  // Words neither the rules nor the model read are refused, never saved
  // as something else.
  parsed.data = { ok: false, reason: "not-understood" };
  await user.clear(when);
  await user.type(when, "whenever it feels right");
  expect(await screen.findByText(/Not sure when/)).toBeInTheDocument();
  const calls = update.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(update.mock.calls.length).toBe(calls);
});

it("words the rules miss go to the model, and its reading is shown before saving", async () => {
  const user = userEvent.setup();
  parsed.data = { ok: true, schedule: "0 9 1 * *" };
  renderWith({ ...cron, gate: null, gateDescription: null });
  const when = screen.getByLabelText("When");
  await user.clear(when);
  await user.type(when, "the first of every month");
  expect(
    await screen.findByText(
      "✓ Every month on the 1st at 09:00",
      {},
      { timeout: 2_000 },
    ),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(update.mock.calls.at(-1)?.[0].input.schedule).toBe("0 9 1 * *");
  parsed.data = undefined;
});
