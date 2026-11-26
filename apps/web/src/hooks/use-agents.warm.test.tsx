// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The warm hint's client-side law: one request per hosted agent per page
// load however many doors fire it (hover, mount, click), none for a BYO
// agent, and a refused hint is forgotten so a later door may try again.

const mocks = vi.hoisted(() => ({
  wake: vi.fn(),
  sandbox: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    agents: { ...actual.agents, wake: mocks.wake, sandbox: mocks.sandbox },
  };
});

const { useWarmAgent, useAgentSandboxStatus, SANDBOX_STATUS_POLL_MS } =
  await import("./use-agents");

const setup = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
};

beforeEach(() => {
  mocks.wake.mockReset();
  mocks.sandbox.mockReset();
});

describe("useWarmAgent", () => {
  it("warms a hosted agent once, however many doors ask", async () => {
    mocks.wake.mockResolvedValue(undefined);
    const { wrapper } = setup();
    const { result } = renderHook(() => useWarmAgent(), { wrapper });

    act(() => {
      result.current({ id: "ag-once", kind: "hosted" });
      result.current({ id: "ag-once", kind: "hosted" });
      result.current({ id: "ag-once", kind: "hosted" });
    });

    await waitFor(() => expect(mocks.wake).toHaveBeenCalledTimes(1));
    expect(mocks.wake).toHaveBeenCalledWith("ag-once");
  });

  it("sends nothing for a BYO agent (no machine) or no agent at all", () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useWarmAgent(), { wrapper });

    act(() => {
      result.current({ id: "ag-byo", kind: "byo" });
      result.current(undefined);
    });

    expect(mocks.wake).not.toHaveBeenCalled();
  });

  it("forgets a refused hint so the next door may try again", async () => {
    mocks.wake
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue(undefined);
    const { wrapper } = setup();
    const { result } = renderHook(() => useWarmAgent(), { wrapper });

    act(() => result.current({ id: "ag-retry", kind: "hosted" }));
    await waitFor(() => expect(mocks.wake).toHaveBeenCalledTimes(1));
    // The failure has to settle before the set forgets the id.
    await waitFor(() => {
      act(() => result.current({ id: "ag-retry", kind: "hosted" }));
      expect(mocks.wake).toHaveBeenCalledTimes(2);
    });
  });
});

describe("useAgentSandboxStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls while the machine is not running and stops once it is", async () => {
    const { wrapper } = setup();
    mocks.sandbox.mockResolvedValueOnce({ status: "starting" });
    const { result } = renderHook(() => useAgentSandboxStatus("ag-1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data?.status).toBe("starting"));
    expect(mocks.sandbox).toHaveBeenCalledTimes(1);

    mocks.sandbox.mockResolvedValue({ status: "running" });
    await act(() => vi.advanceTimersByTimeAsync(SANDBOX_STATUS_POLL_MS + 10));
    expect(mocks.sandbox).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.data?.status).toBe("running"));

    // Running: no later state matters to the one screen that reads this.
    await act(() => vi.advanceTimersByTimeAsync(SANDBOX_STATUS_POLL_MS * 3));
    expect(mocks.sandbox).toHaveBeenCalledTimes(2);
  });

  it("reads nothing without an agent or while disabled", () => {
    const { wrapper } = setup();
    renderHook(() => useAgentSandboxStatus(null), { wrapper });
    renderHook(() => useAgentSandboxStatus("ag-1", { enabled: false }), {
      wrapper,
    });
    expect(mocks.sandbox).not.toHaveBeenCalled();
  });
});
