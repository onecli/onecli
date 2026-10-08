// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalRunDetail } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/** Run polling: only while active, and one history refresh on settling. */

const api = vi.hoisted(() => ({ getRun: vi.fn() }));
vi.mock("@/lib/api", () => ({ evals: { getRun: api.getRun } }));

const { useEvalRun } = await import("./use-evals");

const run = (status: EvalRunDetail["status"]): EvalRunDetail => ({
  id: "run-1",
  status,
  configVersion: "cfg",
  total: 1,
  counts: { pending: 0, passed: 1, mismatch: 0, error: 0, inconclusive: 0 },
  error: null,
  createdAt: "2026-10-07T10:00:00Z",
  startedAt: null,
  finishedAt: null,
  results: [],
  previous: null,
});

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.getRun.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  client.clear();
});

describe("useEvalRun", () => {
  it("polls an active run, refreshes the history once it settles, then stops", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    api.getRun
      .mockResolvedValueOnce(run("running"))
      .mockResolvedValue(run("done"));
    renderHook(() => useEvalRun("ag-1", "run-1"), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(invalidate).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(2_010));
    expect(api.getRun).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.evals.agent("ag-1"),
    });

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.getRun).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("opening a finished run neither polls nor refreshes the history", async () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    api.getRun.mockResolvedValue(run("done"));
    renderHook(() => useEvalRun("ag-1", "run-1"), { wrapper });

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.getRun).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("fetches nothing without a run", async () => {
    renderHook(() => useEvalRun("ag-1", null), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api.getRun).not.toHaveBeenCalled();
  });
});
