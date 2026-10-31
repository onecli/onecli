// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AgentKind } from "@/lib/api/types";

const restart = vi.fn();
const remove = vi.fn();
const idle = { mutate: vi.fn(), isPending: false };

vi.mock("@/hooks/use-agents", () => ({
  useDeleteAgent: () => ({
    mutate: vi.fn(),
    mutateAsync: remove,
    isPending: false,
  }),
  useRenameAgent: () => idle,
  useRestartAgent: () => ({ mutate: restart, isPending: false }),
}));

const { AgentActionsMenu } = await import("./agent-actions-menu");

// Radix's dropdown needs these in jsdom.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  restart.mockReset();
  remove.mockReset();
});
afterEach(cleanup);

const renderMenu = (
  kind: AgentKind,
  channels?: { provider: string }[],
  onDeleted: () => void = vi.fn(),
) =>
  render(
    <AgentActionsMenu
      agent={{ id: "agent-1", name: "Donna", kind, channels }}
      onDetails={vi.fn()}
      onViewActivity={vi.fn()}
      onDeleted={onDeleted}
    />,
  );

const openMenu = () =>
  userEvent.click(screen.getByRole("button", { name: /agent actions/i }));

const openRestartDialog = async () => {
  await openMenu();
  await userEvent.click(
    screen.getByRole("menuitem", { name: /restart agent/i }),
  );
  return screen.getByRole("alertdialog");
};

describe("AgentActionsMenu: Restart agent", () => {
  it("is offered for a hosted agent only", async () => {
    renderMenu("byo");
    await openMenu();
    expect(screen.getByRole("menuitem", { name: /rename/i })).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: /restart agent/i }),
    ).toBeNull();
  });

  it("names the channels the reset reaches, and only those", async () => {
    renderMenu("hosted", [{ provider: "slack" }]);
    expect((await openRestartDialog()).textContent).toMatch(
      /in the dashboard and in Slack\./,
    );
    cleanup();
    renderMenu("hosted");
    expect((await openRestartDialog()).textContent).toMatch(
      /in the dashboard\. The chat history/,
    );
  });

  it("confirms what a restart ends, then restarts and closes on success", async () => {
    restart.mockImplementation(
      (_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.(),
    );
    renderMenu("hosted");
    const dialog = await openRestartDialog();
    expect(dialog.textContent).toMatch(/every conversation/i);
    expect(dialog.textContent).toMatch(/background processes/i);
    expect(restart).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /^restart$/i }));
    expect(restart.mock.calls).toEqual([["agent-1", expect.any(Object)]]);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("keeps the dialog up when the restart fails", async () => {
    // A failure never calls onSuccess: the dialog must stay, so the person
    // sees the restart did not happen.
    restart.mockImplementation(() => undefined);
    renderMenu("hosted");
    await openRestartDialog();
    await userEvent.click(screen.getByRole("button", { name: /^restart$/i }));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

describe("AgentActionsMenu: Delete agent", () => {
  const confirmDelete = async (onDeleted: () => void) => {
    renderMenu("hosted", undefined, onDeleted);
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /delete agent/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
  };

  it("calls onDeleted from the mutation's PROMISE, which survives an unmount", async () => {
    // The agent page unmounts this menu the moment the delete invalidates
    // the agent list (it swaps to "Agent not found"); React Query drops a
    // per-call onSuccess of an unmounted observer. The promise does not.
    remove.mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    await confirmDelete(onDeleted);
    expect(remove).toHaveBeenCalledWith("agent-1");
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it("does not navigate away when the delete fails", async () => {
    remove.mockRejectedValue(new Error("boom"));
    const onDeleted = vi.fn();
    await confirmDelete(onDeleted);
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("AgentActionsMenu: Delete agent double-submit", () => {
  it("deletes once even when Delete is pressed twice before it settles", async () => {
    let settle: () => void = () => {};
    remove.mockImplementation(
      () => new Promise<void>((resolve) => (settle = resolve)),
    );
    const onDeleted = vi.fn();
    renderMenu("hosted", undefined, onDeleted);
    await openMenu();
    await userEvent.click(
      screen.getByRole("menuitem", { name: /delete agent/i }),
    );
    const confirm = screen.getByRole("button", { name: /^delete$/i });
    await userEvent.click(confirm);
    await userEvent.click(confirm);
    expect(remove).toHaveBeenCalledTimes(1);
    settle();
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });
});
