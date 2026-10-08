// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalQuestion } from "@/lib/api";
import type { EffectiveCredentialsResult } from "@/lib/api/policy-visibility";

/**
 * The question dialog through the real save hook: the API client and the
 * effective-credentials query are mocked at their module seams.
 */

const api = vi.hoisted(() => ({
  addQuestion: vi.fn(),
  updateQuestion: vi.fn(),
  credentials: {
    agentId: "ag-1",
    mode: "selective",
    connections: [
      {
        kind: "connection",
        id: "c1",
        label: null,
        provider: "gmail",
        status: "usable",
        orgBlocked: false,
        provenance: [],
      },
    ],
    secrets: [],
  } as EffectiveCredentialsResult,
  credentialsEnabled: [] as boolean[],
}));

vi.mock("@/lib/api", () => ({
  evals: { addQuestion: api.addQuestion, updateQuestion: api.updateQuestion },
}));
vi.mock("@/lib/api/policy-visibility", () => ({
  useEffectiveCredentials: (_agentId: string, enabled: boolean) => {
    api.credentialsEnabled.push(enabled);
    return {
      data: enabled ? api.credentials : undefined,
      isError: false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { QuestionDialog } = await import("./question-dialog");

const question: EvalQuestion = {
  id: "q-1",
  question: "What was Q1 revenue?",
  expected: "3200000",
  kind: "numeric",
  expectedApps: ["gmail"],
};

const mount = (editing: EvalQuestion | null, open = true) => {
  const onClose = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <QuestionDialog
        agentId="ag-1"
        state={{ open, editing, key: 1 }}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { onClose, view, client };
};

beforeEach(() => {
  api.addQuestion.mockReset();
  api.updateQuestion.mockReset();
  api.credentialsEnabled.length = 0;
});
afterEach(() => cleanup());

describe("QuestionDialog", () => {
  it("loads the agent's apps only while open", () => {
    mount(null, false);
    expect(api.credentialsEnabled.length).toBeGreaterThan(0);
    expect(api.credentialsEnabled).not.toContain(true);
  });

  it("adds a question with a keyword check by default", async () => {
    api.addQuestion.mockResolvedValue({ ...question, id: "q-2" });
    const { onClose } = mount(null);
    const user = userEvent.setup();

    expect(
      screen.getByRole("radio", { name: /Keyword check/ }),
    ).toHaveAttribute("aria-checked", "true");
    await user.type(screen.getByLabelText("Question"), "  Who renewed?  ");
    await user.type(screen.getByLabelText("Expected keywords"), "Acme");
    await user.click(screen.getByRole("button", { name: "Add question" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.addQuestion).toHaveBeenCalledWith("ag-1", {
      question: "Who renewed?",
      expected: "Acme",
      kind: "text",
      expectedApps: [],
    });
  });

  it("edits a question in place, starting from its saved values", async () => {
    api.updateQuestion.mockResolvedValue(question);
    const { onClose } = mount(question);
    const user = userEvent.setup();

    expect(screen.getByLabelText("Question")).toHaveValue(question.question);
    expect(screen.getByLabelText("Expected number")).toHaveValue("3200000");
    expect(
      screen.getByRole("list", { name: "Required apps" }),
    ).toHaveTextContent("Gmail");
    await user.click(screen.getByRole("button", { name: "Remove Gmail" }));
    await user.click(screen.getByRole("button", { name: "Save question" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.updateQuestion).toHaveBeenCalledWith("ag-1", "q-1", {
      question: question.question,
      expected: "3200000",
      kind: "numeric",
      expectedApps: [],
    });
  });

  it("refuses a number check that is not one number, focusing the field, without calling the API", async () => {
    mount(null);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Question"), "Revenue?");
    await user.click(screen.getByRole("radio", { name: /Number check/ }));
    const expected = screen.getByLabelText("Expected number");
    await user.type(expected, "about three million");
    await user.click(screen.getByRole("button", { name: "Add question" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter one number",
    );
    expect(expected).toHaveAttribute("aria-invalid", "true");
    expect(expected).toHaveFocus();
    expect(api.addQuestion).not.toHaveBeenCalled();

    await user.type(expected, "x");
    expect(expected).toHaveAttribute("aria-invalid", "false");
  });

  it("moves between check kinds with the arrow keys", async () => {
    mount(null);
    const user = userEvent.setup();
    const keyword = screen.getByRole("radio", { name: /Keyword check/ });
    const numeric = screen.getByRole("radio", { name: /Number check/ });

    await user.click(keyword);
    await user.keyboard("{ArrowLeft}");
    expect(numeric).toHaveAttribute("aria-checked", "true");
    expect(numeric).toHaveFocus();
    expect(screen.getByLabelText("Expected number")).toBeInTheDocument();
  });

  it("keeps the dialog open and shows the server's refusal", async () => {
    api.addQuestion.mockRejectedValue(
      new Error("This agent already has 50 test questions."),
    );
    const { onClose } = mount(null);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Question"), "Who renewed?");
    await user.type(screen.getByLabelText("Expected keywords"), "Acme");
    await user.click(screen.getByRole("button", { name: "Add question" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already has 50 test questions",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("cannot be dismissed while a save is in flight", async () => {
    api.addQuestion.mockReturnValue(new Promise(() => {}));
    const { onClose } = mount(null);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Question"), "Who renewed?");
    await user.type(screen.getByLabelText("Expected keywords"), "Acme");
    await user.click(screen.getByRole("button", { name: "Add question" }));

    expect(
      await screen.findByRole("button", { name: /Saving/ }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });
});
