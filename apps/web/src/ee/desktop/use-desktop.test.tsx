// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "./api";
import { queryKeys } from "@/lib/api/keys";
import { LIVE_POLL_MS } from "@/hooks/use-live-list";
import {
  AWAKE_POLL_MS,
  IDLE_POLL_MS,
  useDesktop,
  useReleaseControl,
  useTakeControl,
  useWakeDesktop,
} from "./use-desktop";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  wake: vi.fn(),
  takeControl: vi.fn(),
  releaseControl: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  get: mocks.get,
  wake: mocks.wake,
  takeControl: mocks.takeControl,
  releaseControl: mocks.releaseControl,
}));

const state = (overrides: Partial<DesktopState> = {}): DesktopState => ({
  available: true,
  sandboxState: "awake",
  viewHost: "d-andy-ab12.preview.example",
  controlHost: null,
  controller: null,
  request: null,
  you: { controlling: false },
  ...overrides,
});

const setup = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useDesktop", () => {
  it("polls fast while the box is asleep or waking, slower once it is awake", async () => {
    const { wrapper } = setup();
    mocks.get.mockResolvedValueOnce(
      state({ sandboxState: "waking", available: false, viewHost: null }),
    );
    const { result } = renderHook(() => useDesktop("ag-1"), { wrapper });
    await waitFor(() =>
      expect(result.current.data?.sandboxState).toBe("waking"),
    );
    expect(mocks.get).toHaveBeenCalledTimes(1);
    // The poll interval follows the latest answer: the first refetch lands
    // at the fast cadence, and once it reports "awake" the next one waits
    // the slow cadence.
    mocks.get.mockResolvedValue(state());
    await act(() => vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10));
    expect(mocks.get).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(result.current.data?.sandboxState).toBe("awake"),
    );
    await act(() => vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10));
    expect(mocks.get).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(AWAKE_POLL_MS - LIVE_POLL_MS));
    expect(mocks.get).toHaveBeenCalledTimes(3);
  });

  it("a surface beside another section glances every 15s, whatever the state", async () => {
    const { wrapper } = setup();
    mocks.get.mockResolvedValue(state({ sandboxState: "waking" }));
    renderHook(() => useDesktop("ag-1", { poll: "idle" }), { wrapper });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    // A waking box would be re-read every LIVE_POLL_MS on the live cadence.
    await act(() => vi.advanceTimersByTimeAsync(IDLE_POLL_MS - 1_000));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("an observer that leaves the polling to another reads once and then follows the cache", async () => {
    const { qc, wrapper } = setup();
    mocks.get.mockResolvedValue(state());
    const { result } = renderHook(() => useDesktop("ag-1", { poll: "off" }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    await act(() => vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 2));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    const ask = { id: "r1", reason: "Sign in", at: "2026-10-20T00:00:00Z" };
    qc.setQueryData(queryKeys.desktop.agent("ag-1"), state({ request: ask }));
    await waitFor(() => expect(result.current.data?.request).toEqual(ask));
  });

  it("a failed refetch keeps the last good answer (only the first load is an error)", async () => {
    const { wrapper } = setup();
    mocks.get.mockResolvedValueOnce(state());
    const { result } = renderHook(() => useDesktop("ag-1"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    mocks.get.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data?.viewHost).toBe("d-andy-ab12.preview.example");
    expect(result.current.isError).toBe(false);
  });
});

describe("useWakeDesktop", () => {
  it("writes the server's answer straight into the cache (the section shows 'starting' on the same tick)", async () => {
    const { qc, wrapper } = setup();
    qc.setQueryData(
      queryKeys.desktop.agent("ag-1"),
      state({ sandboxState: "asleep", viewHost: null }),
    );
    const waking = state({ sandboxState: "waking", viewHost: null });
    mocks.wake.mockResolvedValueOnce(waking);
    const { result } = renderHook(() => useWakeDesktop("ag-1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(qc.getQueryData(queryKeys.desktop.agent("ag-1"))).toEqual(waking);
  });
});

describe("useTakeControl", () => {
  it("writes the server's answer straight into the cache (the control host is usable on the same tick)", async () => {
    const { qc, wrapper } = setup();
    qc.setQueryData(queryKeys.desktop.agent("ag-1"), state());
    const granted = state({
      controlHost: "d-andy-ab12-ctl.preview.example",
      controller: { userId: "u1", name: "Alex", since: "2026-10-17T00:00:00Z" },
      you: { controlling: true },
    });
    mocks.takeControl.mockResolvedValueOnce(granted);
    const { result } = renderHook(() => useTakeControl("ag-1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(qc.getQueryData(queryKeys.desktop.agent("ag-1"))).toEqual(granted);
  });
});

describe("useReleaseControl", () => {
  it("hands back, then refreshes the state", async () => {
    const { qc, wrapper } = setup();
    const key = queryKeys.desktop.agent("ag-1");
    qc.setQueryData(key, state({ you: { controlling: true } }));
    // The refresh is an invalidation: only an OBSERVED query refetches, so
    // the state hook is mounted beside the mutation, as on the page.
    mocks.get.mockResolvedValue(state());
    renderHook(() => useDesktop("ag-1"), { wrapper });
    mocks.releaseControl.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useReleaseControl("ag-1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(mocks.releaseControl).toHaveBeenCalledWith("ag-1");
    await waitFor(() =>
      expect(qc.getQueryData<DesktopState>(key)?.you.controlling).toBe(false),
    );
  });
});
