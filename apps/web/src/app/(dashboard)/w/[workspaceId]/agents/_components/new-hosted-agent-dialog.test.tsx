// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The create dialog's promise: ONE required question. The brief is opt-in
 * (it used to sit open and read as required), and creating lands in the chat
 * rather than a second dialog step.
 */

const state = vi.hoisted(() => ({ availability: "ready" as string }));
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  mutate: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "w1" }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/hooks/use-agents", () => ({
  useCreateHostedAgent: () => ({
    mutate: mocks.mutate,
    reset: mocks.reset,
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => state.availability,
  useHomeDurabilityMessage: () => null,
}));
// The key dialog is a whole flow of its own; only its presence matters here.
vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog",
  () => ({
    SecretDialog: ({ open }: { open: boolean }) =>
      open ? <div>secret-dialog</div> : null,
  }),
);

const { NewHostedAgentDialog } = await import("./new-hosted-agent-dialog");

const open = () => render(<NewHostedAgentDialog open onOpenChange={vi.fn()} />);

const nameField = () =>
  screen.getByPlaceholderText("e.g. Support Triage") as HTMLInputElement;

beforeEach(() => {
  state.availability = "ready";
  mocks.push.mockClear();
  mocks.mutate.mockClear();
});

describe("the hosted create dialog", () => {
  it("opens with a name already filled in, so nobody faces a blank box", () => {
    open();
    expect(nameField().value).not.toBe("");
    expect(screen.getByRole("button", { name: "Create agent" })).toBeEnabled();
  });

  it("leaves a collapsed caret at the end, never a selection — one keystroke must not wipe the suggestion", async () => {
    open();
    const field = nameField();
    const end = field.value.length;
    // The dialog selects the field on autofocus; the caret is collapsed on the
    // next frame, so assert only once that frame has actually run.
    field.select();
    expect(field.selectionStart).toBe(0);
    await act(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
    });
    expect(field.selectionStart).toBe(end);
    expect(field.selectionEnd).toBe(end);
  });

  it("asks one question — the brief is behind a disclosure", () => {
    open();
    expect(screen.getByPlaceholderText("e.g. Support Triage")).toBeVisible();
    expect(screen.queryByLabelText("What should it do?")).toBeNull();
    expect(
      screen.getByRole("button", { name: /add a brief/i }),
    ).toBeInTheDocument();
  });

  it("creates from a name alone, deriving the identifier", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(nameField());
    await user.type(nameField(), "Support Triage");
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      { name: "Support Triage", identifier: "support-triage" },
      expect.anything(),
    );
  });

  it("submits on Enter — a one-field form needs no mouse", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(nameField());
    await user.type(nameField(), "Donna{Enter}");
    expect(mocks.mutate).toHaveBeenCalledWith(
      { name: "Donna", identifier: "donna" },
      expect.anything(),
    );
  });

  it("sends the brief once it has been opened and filled", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(nameField());
    await user.type(nameField(), "Donna");
    await user.click(screen.getByRole("button", { name: /add a brief/i }));
    await user.type(
      screen.getByLabelText("What should it do?"),
      "Triage the inbox.",
    );
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      { name: "Donna", identifier: "donna", instructions: "Triage the inbox." },
      expect.anything(),
    );
  });

  it("closes the brief again, discarding it so nothing hidden is submitted", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(nameField());
    await user.type(nameField(), "Donna");
    await user.click(screen.getByRole("button", { name: /add a brief/i }));
    await user.type(
      screen.getByLabelText("What should it do?"),
      "Triage the inbox.",
    );
    await user.click(screen.getByRole("button", { name: /discard/i }));

    expect(screen.queryByLabelText("What should it do?")).toBeNull();
    expect(
      screen.getByRole("button", { name: /add a brief/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      { name: "Donna", identifier: "donna" },
      expect.anything(),
    );
  });

  it("lands in the chat instead of a success step", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(nameField());
    await user.type(nameField(), "Donna");
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    const onSuccess = mocks.mutate.mock.calls[0]![1].onSuccess;
    onSuccess({ id: "ag-1", name: "Donna", llmKeys: ["sec-1"] });
    expect(mocks.push).toHaveBeenCalledWith("/w/w1/agents/ag-1/chat");
  });

  it("asks for an LLM key instead of landing in a room the agent cannot answer in", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(nameField());
    await user.type(nameField(), "Donna");
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    const onSuccess = mocks.mutate.mock.calls[0]![1].onSuccess;
    act(() => onSuccess({ id: "ag-1", name: "Donna", llmKeys: [] }));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByText("secret-dialog")).toBeVisible();
  });

  it("won't submit once the suggested name is cleared away", async () => {
    const user = userEvent.setup();
    open();
    await user.clear(nameField());
    expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
  });

  it("won't submit while the agents are offline, and says why", () => {
    state.availability = "offline";
    open();
    expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
    expect(screen.getByText(/can't start until they're back/i)).toBeVisible();
  });
});
