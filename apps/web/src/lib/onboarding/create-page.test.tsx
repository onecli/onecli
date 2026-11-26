// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The unit here is the end of onboarding. The agent was created at the
// welcome step (as the default name) so its machine has been booting the
// whole time; the name step RENAMES it, and the boot screen's door opens once
// the machine is actually running (bounded, so a slow boot never traps the
// person). The door completes into the agent's chat, where the agent speaks
// first (the greeting the early thread open queued).
const mocks = vi.hoisted(() => ({
  handleComplete: vi.fn().mockResolvedValue(undefined),
  prefetch: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  recordCreatedAgent: vi.fn(),
  setStarterFace: vi.fn(),
  // The machine's status the boot screen reads; `undefined` = not answered.
  sandboxStatus: undefined as string | null | undefined,
  createPending: false,
  renamePending: false,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    prefetch: mocks.prefetch,
    replace: vi.fn(),
    push: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-agents", () => ({
  useCreateHostedAgent: () => ({
    isPending: mocks.createPending,
    mutateAsync: mocks.create,
  }),
  useRenameOnboardingAgent: () => ({
    isPending: mocks.renamePending,
    mutateAsync: mocks.rename,
  }),
  useSetStarterFace: () => mocks.setStarterFace,
  useAgentSandboxStatus: () => ({
    data:
      mocks.sandboxStatus === undefined
        ? undefined
        : { status: mocks.sandboxStatus },
  }),
}));

const onboarding = {
  createdAgentId: null as string | null,
  createdAgentName: null as string | null,
  workspaceId: "ws-1",
  completing: false,
  recordCreatedAgent: mocks.recordCreatedAgent,
  handleComplete: mocks.handleComplete,
  get progress() {
    return {
      discovery: [],
      agentName: this.createdAgentName,
      createdAgentId: this.createdAgentId,
    };
  },
};

vi.mock("./onboarding-context", () => ({
  useOnboarding: () => onboarding,
}));

import CreatePage, { BOOT_WAIT_MAX_MS } from "./create-page";
import { AGENT_NAMES } from "@/lib/agents/agent-names";

const CHAT_DESTINATION = "/w/ws-1/agents/ag-1/chat";

beforeEach(() => {
  mocks.setStarterFace.mockClear();
  mocks.handleComplete.mockClear();
  mocks.prefetch.mockClear();
  mocks.create.mockReset();
  mocks.rename.mockReset();
  mocks.recordCreatedAgent.mockClear();
  mocks.sandboxStatus = undefined;
  mocks.createPending = false;
  mocks.renamePending = false;
  onboarding.createdAgentId = null;
  onboarding.createdAgentName = null;
});

describe("the resume onto a named agent (the name step was passed)", () => {
  beforeEach(() => {
    onboarding.createdAgentId = "ag-1";
    onboarding.createdAgentName = "Max";
    mocks.sandboxStatus = "running";
  });

  it("resumes straight onto the boot screen, and a running machine opens the door", () => {
    render(<CreatePage />);

    expect(screen.getByText("Max is getting ready")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /meet max/i }),
    ).toBeInTheDocument();
  });

  it("speaks plain language: no sandbox, credential or gateway jargon", () => {
    render(<CreatePage />);

    expect(screen.getByText("Setting up Max")).toBeInTheDocument();
    expect(
      screen.getByText("Giving Max a safe space of its own"),
    ).toBeInTheDocument();
    expect(screen.getByText("Keeping your passwords safe")).toBeInTheDocument();
    expect(
      screen.queryByText(/sandbox|credential|gateway|provision/i),
    ).toBeNull();
  });

  it("the door eases the screen out, then completes into the agent's chat", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    await user.click(screen.getByRole("button", { name: /meet max/i }));

    await waitFor(() =>
      expect(mocks.handleComplete).toHaveBeenCalledExactlyOnceWith(
        CHAT_DESTINATION,
      ),
    );
  });

  it("prefetches the chat destination while the boot screen shows", () => {
    render(<CreatePage />);

    expect(mocks.prefetch).toHaveBeenCalledWith(CHAT_DESTINATION);
  });
});

describe("the agent born at the welcome step (the common path)", () => {
  beforeEach(() => {
    // Created as the default name, so the name step has NOT been passed:
    // the pitch and the form still show.
    onboarding.createdAgentId = "ag-1";
    onboarding.createdAgentName = "Donna";
  });

  it("opens on the tools promise, then the name form, on a random famous assistant (never the placeholder) with a picture", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);

    expect(
      screen.getByRole("heading", {
        name: "Works with all your tools, safely",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /get started/i }));
    const value = (screen.getByLabelText("Agent name") as HTMLInputElement)
      .value;
    expect(AGENT_NAMES).toContain(value);
    expect(value).not.toBe("Donna");
    expect(document.querySelector("img")?.getAttribute("src")).toMatch(
      /^\/agent-faces\/robot-\d{2}\.jpg$/,
    );
  });

  it("Shuffle rolls another name and picture, still never the placeholder", async () => {
    const user = userEvent.setup();
    render(<CreatePage />);
    await user.click(screen.getByRole("button", { name: /get started/i }));
    const field = screen.getByLabelText("Agent name") as HTMLInputElement;
    const picture = () => document.querySelector("img")?.getAttribute("src");
    const [firstName, firstFace] = [field.value, picture()];

    await user.click(
      screen.getByRole("button", { name: "Shuffle name and picture" }),
    );

    expect(field.value).not.toBe(firstName);
    expect(field.value).not.toBe("Donna");
    expect(AGENT_NAMES).toContain(field.value);
    expect(picture()).not.toBe(firstFace);
  });

  it("renames the existing agent on submit instead of creating a second one", async () => {
    const user = userEvent.setup();
    mocks.rename.mockResolvedValue({ success: true });
    render(<CreatePage />);

    await user.click(screen.getByRole("button", { name: /get started/i }));
    const field = screen.getByLabelText("Agent name");
    const face = Number(
      document
        .querySelector("img")!
        .getAttribute("src")!
        .match(/robot-(\d{2})/)![1],
    );
    await user.clear(field);
    await user.type(field, "Max");
    await user.click(screen.getByRole("button", { name: /let's go/i }));

    await waitFor(() =>
      expect(mocks.rename).toHaveBeenCalledExactlyOnceWith({
        agentId: "ag-1",
        name: "Max",
        workspaceId: "ws-1",
      }),
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.recordCreatedAgent).toHaveBeenCalledWith({
      agentId: "ag-1",
      agentName: "Max",
    });
    // Onboarding's URL carries no workspace, so the upload must name it or
    // the server refuses it (401).
    expect(mocks.setStarterFace).toHaveBeenCalledWith("ag-1", face - 1, "ws-1");
  });

  it("accepting the suggestion renames the placeholder agent to it", async () => {
    const user = userEvent.setup();
    mocks.rename.mockResolvedValue({ success: true });
    render(<CreatePage />);

    await user.click(screen.getByRole("button", { name: /get started/i }));
    const suggested = (screen.getByLabelText("Agent name") as HTMLInputElement)
      .value;
    await user.click(screen.getByRole("button", { name: /let's go/i }));

    await waitFor(() =>
      expect(mocks.rename).toHaveBeenCalledExactlyOnceWith({
        agentId: "ag-1",
        name: suggested,
        workspaceId: "ws-1",
      }),
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("a resumed flow whose agent already has a name goes straight to the boot screen", () => {
    // Progress follows the name: a non-placeholder name = step passed.
    onboarding.createdAgentName = "Max";
    render(<CreatePage />);

    expect(screen.getByText("Max is getting ready")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent name")).toBeNull();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("the boot lines follow the machine, and the door waits for it to run", async () => {
    const user = userEvent.setup();
    mocks.sandboxStatus = "starting";
    mocks.rename.mockResolvedValue({ success: true });
    render(<CreatePage />);

    await user.click(screen.getByRole("button", { name: /get started/i }));
    const field = screen.getByLabelText("Agent name");
    await user.clear(field);
    await user.type(field, "Max");
    await user.click(screen.getByRole("button", { name: /let's go/i }));

    // `starting`: the first line is done, the second is in progress, and the
    // door is shut.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Giving Max a safe space of its own");
    expect(screen.queryByRole("button", { name: /meet max/i })).toBeNull();
  });
});

describe("the boot screen's bound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    onboarding.createdAgentId = "ag-1";
    onboarding.createdAgentName = "Max";
    // The machine never reports running in these tests.
    mocks.sandboxStatus = "starting";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the door anyway after the wait, so a slow boot never traps the person", async () => {
    render(<CreatePage />);

    expect(screen.queryByRole("button", { name: /meet max/i })).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(BOOT_WAIT_MAX_MS);
    });
    expect(
      screen.getByRole("button", { name: /meet max/i }),
    ).toBeInTheDocument();
  });
});

describe("the fallback: no agent was born at the welcome step", () => {
  it("creates on submit as before, and the door never opens on a create that never settles", async () => {
    vi.useFakeTimers();
    try {
      render(<CreatePage />);

      // fireEvent (not userEvent): synchronous, so it cannot deadlock with
      // the fake clock this test owns.
      mocks.create.mockReturnValue(new Promise(() => {}));
      fireEvent.click(screen.getByRole("button", { name: /get started/i }));
      fireEvent.submit(screen.getByRole("button", { name: /let's go/i }));

      expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
        name: expect.stringMatching(/\S/),
        workspaceId: "ws-1",
      });
      const created = mocks.create.mock.calls[0]![0].name as string;
      expect(AGENT_NAMES).toContain(created);
      // Even past the bound: there is no agent, so there is no door.
      await act(async () => {
        vi.advanceTimersByTime(BOOT_WAIT_MAX_MS + 1_000);
      });
      expect(screen.getByText(/is getting ready/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^meet /i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
