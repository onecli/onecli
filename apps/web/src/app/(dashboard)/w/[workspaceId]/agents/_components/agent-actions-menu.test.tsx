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

const restart = vi.fn();
const idle = { mutate: vi.fn(), isPending: false };

vi.mock("@/hooks/use-agents", () => ({
  useDeleteAgent: () => idle,
  useRegenerateToken: () => idle,
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

beforeEach(() => restart.mockReset());
afterEach(cleanup);

const renderMenu = (kind: string, channels?: { provider: string }[]) =>
  render(
    <AgentActionsMenu
      agent={{ id: "agent-1", name: "Donna", kind, channels }}
      onCredentialAccess={vi.fn()}
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
    expect(
      screen.getByRole("menuitem", { name: /rotate token/i }),
    ).toBeTruthy();
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
