// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bring-your-own create dialog's success step. A new agent starts with no
 * connection, so when the workspace has some to offer, the step's next door
 * is choosing them, beside the identifier the user still has to copy.
 */

const state = vi.hoisted(() => ({
  counts: { apps: 0, secrets: 0 },
  renderedCounts: undefined as { apps: number; secrets: number } | undefined,
}));
const mocks = vi.hoisted(() => ({ mutate: vi.fn(), onOpenChange: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-agents", () => ({
  useCreateAgent: () => ({ mutate: mocks.mutate, isPending: false }),
}));
// The rendered counts may lag; the chooser decision asks the live answer.
vi.mock("@/hooks/use-counts", () => ({
  useCounts: () => ({ data: state.renderedCounts ?? state.counts }),
  useHasConnectionsToChoose: () => async () =>
    state.counts.apps + state.counts.secrets > 0,
}));
// The key dialog and the chooser are flows of their own; only their presence
// and how they close matter here. Like the real one, the key dialog calls
// onSaved and then closes itself.
vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog",
  () => ({
    SecretDialog: ({
      open,
      onSaved,
      onOpenChange,
    }: {
      open: boolean;
      onSaved?: () => void;
      onOpenChange: (open: boolean) => void;
    }) =>
      open ? (
        <button
          onClick={() => {
            onSaved?.();
            onOpenChange(false);
          }}
        >
          save key
        </button>
      ) : null,
  }),
);
vi.mock("./choose-connections-dialog", () => ({
  ChooseConnectionsDialog: ({
    agent,
    onClose,
  }: {
    agent: { id: string; name: string } | null;
    onClose: () => void;
  }) =>
    agent ? (
      <button onClick={onClose}>
        choose for {agent.name} ({agent.id})
      </button>
    ) : null,
}));

const { CreateAgentDialog } = await import("./create-agent-dialog");

/** Fills the form, submits, and lands the create with the given LLM keys. */
const createAgent = async (llmKeys: string[]) => {
  const user = userEvent.setup();
  render(<CreateAgentDialog open onOpenChange={mocks.onOpenChange} />);
  await user.type(screen.getByLabelText("Name"), "Donna");
  await user.click(screen.getByRole("button", { name: "Create" }));
  const onSuccess = mocks.mutate.mock.calls[0]![1].onSuccess;
  act(() =>
    onSuccess({ id: "ag-1", name: "Donna", identifier: "donna", llmKeys }),
  );
  return user;
};

beforeEach(() => {
  state.counts = { apps: 0, secrets: 0 };
  state.renderedCounts = undefined;
  mocks.mutate.mockClear();
  mocks.onOpenChange.mockClear();
});

describe("the bring-your-own create dialog's success step", () => {
  it("pops the chooser right after create when the workspace has connections, then shows the identifier", async () => {
    state.counts = { apps: 2, secrets: 1 };
    const user = await createAgent(["sec-1"]);

    // No click needed: the chooser is up for the agent just made, and the
    // success step steps aside for it.
    const chooser = await screen.findByRole("button", {
      name: "choose for Donna (ag-1)",
    });
    expect(screen.queryByText("Agent created")).toBeNull();
    await user.click(chooser);

    // Back on the success step, identifier there to copy; it can reopen the
    // chooser, and Done closes the flow.
    expect(mocks.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText("donna")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Choose connections" }),
    );
    await user.click(
      screen.getByRole("button", { name: "choose for Donna (ag-1)" }),
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(mocks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("still pops the chooser when the create answers before the counts first loaded", async () => {
    // The render saw no counts yet (zero); the workspace does have some.
    state.renderedCounts = { apps: 0, secrets: 0 };
    state.counts = { apps: 1, secrets: 0 };
    await createAgent(["sec-1"]);
    expect(
      await screen.findByRole("button", { name: "choose for Donna (ag-1)" }),
    ).toBeInTheDocument();
  });

  it("just says Done when the workspace has nothing to choose", async () => {
    await createAgent(["sec-1"]);
    expect(screen.queryByRole("button", { name: /^choose for/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Choose connections" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("asks for the LLM key first, then pops the chooser", async () => {
    state.counts = { apps: 1, secrets: 0 };
    const user = await createAgent([]);
    // Keyless: the key comes first, the chooser waits.
    expect(screen.queryByRole("button", { name: /^choose for/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add LLM key" }));
    await user.click(screen.getByRole("button", { name: "save key" }));

    // The key no longer ends the flow: the chooser pops next.
    expect(
      await screen.findByRole("button", { name: "choose for Donna (ag-1)" }),
    ).toBeInTheDocument();
    expect(mocks.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("closes once the key is saved when there is nothing to choose", async () => {
    const user = await createAgent([]);
    await user.click(screen.getByRole("button", { name: "Add LLM key" }));
    await user.click(screen.getByRole("button", { name: "save key" }));
    await waitFor(() => expect(mocks.onOpenChange).toHaveBeenCalledWith(false));
  });
});
