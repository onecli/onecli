// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMemorySummary, MemoryRevision } from "@/lib/api";

/**
 * The Memory section, one describe per state (the schedules-section
 * pattern): empty, rows, the editor, and the history sheet's restore/redact
 * guards. Hooks are mocked at the module seam; the API client and the DB
 * laws are covered elsewhere.
 */

const state = vi.hoisted(() => ({
  memories: [] as unknown[],
  revisions: [] as unknown[],
  isPending: false,
  isError: false,
  detail: null as unknown,
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  redact: vi.fn(),
}));

vi.mock("@/hooks/use-memories", () => ({
  useMemories: () => ({
    data:
      state.isPending || state.isError
        ? undefined
        : { memories: state.memories },
    isPending: state.isPending,
    isError: state.isError,
  }),
  useMemory: () => ({
    data: state.detail,
    isPending: state.detail === null,
    isSuccess: state.detail !== null,
    isError: false,
  }),
  useMemoryRevisions: () => ({
    data: { revisions: state.revisions },
    isPending: false,
    isError: false,
  }),
  // Previews in these fixtures are never truncated, so the full-revision
  // fetch stays disabled — pending-but-disabled is what a real disabled
  // query reports.
  useMemoryRevision: () => ({
    data: undefined,
    isPending: true,
    isError: false,
  }),
  useCreateMemory: () => ({ mutate: state.create, isPending: false }),
  useUpdateMemory: () => ({ mutate: state.update, isPending: false }),
  useDeleteMemory: () => ({ mutate: state.remove, isPending: false }),
  useRestoreRevision: () => ({ mutate: state.restore, isPending: false }),
  useRedactRevision: () => ({ mutate: state.redact, isPending: false }),
}));

vi.mock("../../_components/agent-page-frame", () => ({
  useAgentPageAgent: () => ({ id: "ag-1", name: "andy", kind: "hosted" }),
}));

const { MemorySection } = await import("./memory-section");

const memory = (
  overrides: Partial<AgentMemorySummary> = {},
): AgentMemorySummary => ({
  id: "mem-1",
  agentId: "ag-1",
  key: "deploy-notes",
  title: "Deploy notes",
  description: "How we deploy the api",
  lastRevisionSeq: 2,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
  ...overrides,
});

const revision = (overrides: Partial<MemoryRevision> = {}): MemoryRevision => ({
  id: "rev-2",
  seq: 2,
  op: "save",
  restoredFromSeq: null,
  title: "Deploy notes",
  description: null,
  content: "Deploys run from CI.",
  authorKind: "user",
  authorUserId: "user-1",
  authorEmail: "admin@example.com",
  conversationId: null,
  turnId: null,
  redactedAt: null,
  redactedByUserId: null,
  createdAt: "2026-08-07T00:00:00.000Z",
  ...overrides,
});

const renderSection = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemorySection />
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.memories = [];
  state.revisions = [];
  state.isPending = false;
  state.isError = false;
  state.detail = null;
  for (const fn of [
    state.create,
    state.update,
    state.remove,
    state.restore,
    state.redact,
  ]) {
    fn.mockReset();
  }
});
afterEach(cleanup);

describe("load states", () => {
  it("error renders NO mutating controls — the apps-tab law", () => {
    state.isError = true;
    renderSection();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Memory failed to load",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("empty offers creation and points at the chat door", () => {
    renderSection();
    expect(screen.getByText("Nothing remembered yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /New memory/ }),
    ).toBeInTheDocument();
  });
});

describe("rows", () => {
  it("renders title, key, description, and the version count", () => {
    state.memories = [memory()];
    renderSection();
    expect(screen.getByText("Deploy notes")).toBeInTheDocument();
    expect(screen.getByText("deploy-notes")).toBeInTheDocument();
    expect(screen.getByText("How we deploy the api")).toBeInTheDocument();
    expect(screen.getByText(/2 versions/)).toBeInTheDocument();
  });

  it("falls back to the key when there is no title", () => {
    state.memories = [memory({ title: null })];
    renderSection();
    expect(screen.getByText("deploy-notes")).toBeInTheDocument();
  });
});

describe("the editor", () => {
  it("create submits exactly the typed fields", async () => {
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: /New memory/ }));
    await userEvent.type(screen.getByLabelText("Key"), "staging-url");
    await userEvent.type(
      screen.getByLabelText("Content"),
      "https://staging.acme.io",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(state.create).toHaveBeenCalledWith(
      { key: "staging-url", content: "https://staging.acme.io" },
      expect.anything(),
    );
  });

  it("edit disables the key (immutable) and PATCHes the rest", async () => {
    state.memories = [memory()];
    state.detail = { ...memory(), content: "Deploys run from CI." };
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit deploy-notes" }),
    );
    const key = screen.getByLabelText("Key") as HTMLInputElement;
    expect(key).toBeDisabled();
    expect(key.value).toBe("deploy-notes");

    const content = screen.getByLabelText("Content");
    await userEvent.clear(content);
    await userEvent.type(content, "Deploys run from CD now.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(state.update).toHaveBeenCalledWith(
      {
        memoryId: "mem-1",
        patch: {
          title: "Deploy notes",
          description: "How we deploy the api",
          content: "Deploys run from CD now.",
        },
      },
      expect.anything(),
    );
  });

  it("delete fires from the editor footer", async () => {
    state.memories = [memory()];
    state.detail = { ...memory(), content: "x" };
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit deploy-notes" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(state.remove).toHaveBeenCalledWith("mem-1", expect.anything());
  });
});

describe("history", () => {
  it("restore targets the selected old revision; both actions are frozen on the current one", async () => {
    state.memories = [memory()];
    state.revisions = [
      revision(),
      revision({ id: "rev-1", seq: 1, content: "Old content" }),
    ];
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "History of deploy-notes" }),
    );

    // The newest revision is selected by default — current, so frozen.
    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redact" })).toBeDisabled();

    // Select the old one; restore goes through with its id.
    await userEvent.click(screen.getByRole("button", { name: /#1/ }));
    const restoreButton = screen.getByRole("button", {
      name: "Restore this version",
    });
    expect(restoreButton).toBeEnabled();
    await userEvent.click(restoreButton);
    expect(state.restore).toHaveBeenCalledWith(
      { memoryId: "mem-1", revisionId: "rev-1" },
      expect.anything(),
    );
  });

  it("redact is confirm-gated and carries the revision id", async () => {
    state.memories = [memory()];
    state.revisions = [
      revision(),
      revision({ id: "rev-1", seq: 1, content: "leaked secret" }),
    ];
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "History of deploy-notes" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /#1/ }));
    await userEvent.click(screen.getByRole("button", { name: "Redact" }));

    // Nothing mutates until the destructive confirm.
    expect(state.redact).not.toHaveBeenCalled();
    expect(screen.getByText(/permanently blacked out/)).toBeInTheDocument();
    // Two "Redact" buttons exist now — the sheet action and the dialog's
    // destructive confirm; the confirm is the last in the tree.
    const confirm = screen
      .getAllByRole("button", { name: "Redact" })
      .at(-1) as HTMLElement;
    await userEvent.click(confirm);
    expect(state.redact).toHaveBeenCalledWith(
      { memoryId: "mem-1", revisionId: "rev-1" },
      expect.anything(),
    );
  });

  it("a redacted revision renders its stamp, never content", async () => {
    state.memories = [memory()];
    state.revisions = [
      revision(),
      revision({
        id: "rev-1",
        seq: 1,
        content: "[redacted]",
        redactedAt: "2026-08-07T01:00:00.000Z",
      }),
    ];
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "History of deploy-notes" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /#1/ }));
    expect(screen.getByText(/This version was redacted/)).toBeInTheDocument();
    expect(screen.getByText("redacted")).toBeInTheDocument();
  });
});
