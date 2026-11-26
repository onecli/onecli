// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_REFRESH_INTERVAL_MS, useVaultStatus } from "./use-vault-status";

// A vault can be revoked on its own side while the page is open; an
// auto-refreshing status has to notice without a reload, and only then.
vi.mock("@/lib/gateway-url", () => ({
  getGatewayApiUrl: () => "http://gw.test",
}));
vi.mock("@/lib/gateway-auth", () => ({
  getGatewayFetchOptions: async () => ({
    headers: {},
    credentials: "include" as const,
  }),
}));

const fetchMock = vi.fn<typeof fetch>();
const ok = () =>
  new Response(JSON.stringify({ connected: true, status_data: null }), {
    status: 200,
  });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock.mockImplementation(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("useVaultStatus", () => {
  it("checks once on mount and stays put by default", async () => {
    renderHook(() => useVaultStatus("bitwarden"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(() =>
      vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS * 2),
    );
    window.dispatchEvent(new Event("focus"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-checks periodically and on focus when auto-refreshing", async () => {
    renderHook(() => useVaultStatus("keepersecurity", { autoRefresh: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "http://gw.test/v1/vault/keepersecurity/status",
    );
  });

  it("stops re-checking once unmounted", async () => {
    const { unmount } = renderHook(() =>
      useVaultStatus("keepersecurity", { autoRefresh: true }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unmount();
    await act(() =>
      vi.advanceTimersByTimeAsync(STATUS_REFRESH_INTERVAL_MS * 2),
    );
    window.dispatchEvent(new Event("focus"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
