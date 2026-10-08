// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunDetail } from "@/lib/api";
import { formatTimestamp } from "@/lib/format-timestamp";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ runs: { get } }));
const { RunDetailSheet } = await import("./run-detail-sheet");

const detail = (patch: Partial<RunDetail> = {}): RunDetail => ({
  turnId: "real-turn",
  conversationId: "conversation",
  agent: { id: "agent", name: "Donna" },
  source: "eval",
  direct: false,
  status: "failed",
  question: "Real question",
  answer: null,
  error: "Actual failure",
  askedBy: { id: "user", email: "ada@example.com", name: "Ada" },
  toolNames: [],
  appsUsed: [],
  appAttribution: "withheld",
  createdAt: "2026-09-10T10:20:30Z",
  startedAt: null,
  finishedAt: null,
  durationMs: 2500,
  tools: [],
  appCalls: [],
  ...patch,
});

const mount = (
  turnId: string | null = "real-turn",
  onViewNetwork?: () => void,
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RunDetailSheet
        agentId="agent"
        turnId={turnId}
        onOpenChange={vi.fn()}
        onViewNetwork={onViewNetwork}
      />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  get.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("RunDetailSheet", () => {
  it("polls a dispatched run until it settles, then stops", async () => {
    vi.useFakeTimers();
    try {
      get
        .mockResolvedValueOnce({ run: detail({ status: "dispatched" }) })
        .mockResolvedValue({ run: detail() });
      mount();
      await act(() => vi.advanceTimersByTimeAsync(10));
      expect(screen.getByText("Running")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(5_010));
      expect(get).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Failed")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the real requester, time, source, outcome and duration", async () => {
    get.mockResolvedValue({ run: detail() });
    mount();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("agent", "real-turn");
    expect(
      screen.getByText(formatTimestamp("2026-09-10T10:20:30Z")),
    ).toBeInTheDocument();
    expect(screen.getByText("Test")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("2.5 s")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Actual failure");
    expect(screen.getByText("No answer.")).toBeInTheDocument();
  });

  it("never claims no apps were called when evidence is withheld or empty", async () => {
    get.mockResolvedValueOnce({ run: detail() });
    mount();
    expect(
      await screen.findByText(/App activity is not available/),
    ).toHaveTextContent("does not mean no apps were called");
    cleanup();
    get.mockResolvedValueOnce({
      run: detail({ appAttribution: "agent_time_window" }),
    });
    mount();
    expect(
      await screen.findByText(/No app calls were found/),
    ).toHaveTextContent("can still be missed");
  });

  it("lists app calls without any request path", async () => {
    get.mockResolvedValue({
      run: detail({
        appAttribution: "agent_time_window",
        appCalls: [
          {
            provider: "example-app",
            host: "api.example.com",
            method: "POST",
            status: 502,
            latencyMs: 40,
            at: "2026-09-10T10:20:31Z",
          },
        ],
      }),
    });
    mount();
    expect(await screen.findByText("POST api.example.com")).toBeInTheDocument();
    expect(screen.getByText("502")).toHaveClass("text-destructive");
    expect(screen.getByText("40 ms")).toBeInTheDocument();
  });

  it("offers View requests in Network only where the host provides it (Activity)", async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ run: detail() });
    const onViewNetwork = vi.fn();
    mount("real-turn", onViewNetwork);
    await user.click(
      await screen.findByRole("button", { name: "View requests in Network" }),
    );
    expect(onViewNetwork).toHaveBeenCalledOnce();
    cleanup();
    mount();
    await screen.findByText("Ada");
    expect(
      screen.queryByRole("button", { name: "View requests in Network" }),
    ).not.toBeInTheDocument();
  });

  it("shows the steps with their requests as text, never markup", async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({
      run: detail({
        status: "done",
        error: null,
        answer: "Done",
        tools: [
          {
            callId: "c1",
            name: "bash",
            input: JSON.stringify({ command: "echo '<img src=x>'" }),
            output: "ok",
            isError: false,
          },
        ],
      }),
    });
    const { container } = mount();
    await user.click(await screen.findByRole("button", { name: /echo/ }));
    expect(screen.getByText("Request")).toBeInTheDocument();
    expect(container.ownerDocument.querySelector("img")).toBeNull();
  });

  it("does not invent header fields while loading", () => {
    get.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByText("Loading run")).toBeInTheDocument();
    expect(screen.queryByText("Platform")).not.toBeInTheDocument();
    expect(screen.queryByText("Test")).not.toBeInTheDocument();
  });

  it("shows a load error without an invented header", async () => {
    get.mockRejectedValue(new Error("Not found"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This run could not be loaded.",
    );
    expect(screen.queryByText("Platform")).not.toBeInTheDocument();
  });

  it("fetches nothing while closed", async () => {
    mount(null);
    await waitFor(() => expect(get).not.toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
