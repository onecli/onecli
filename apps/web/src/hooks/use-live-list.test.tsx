// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  infiniteQueryOptions,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_POLL_MS, useLiveList } from "./use-live-list";

/**
 * Activity's Live list: Live polls one page; Load more pauses Live (an
 * infinite refetch would re-read every loaded page); turning Live back on
 * trims to the first page before polling resumes.
 */

interface Page {
  items: string[];
  next: number | null;
}
const fetchPage = vi.fn<(cursor: number | undefined) => Promise<Page>>();

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const mount = () =>
  renderHook(
    () =>
      useLiveList(
        infiniteQueryOptions({
          queryKey: ["live-list-test"],
          queryFn: ({ pageParam }) => fetchPage(pageParam),
          initialPageParam: undefined as number | undefined,
          getNextPageParam: (page) => page.next ?? undefined,
        }),
      ),
    { wrapper },
  );

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchPage.mockReset();
  fetchPage.mockImplementation(async (cursor) =>
    cursor === undefined
      ? { items: ["new"], next: 1 }
      : { items: [`older-${cursor}`], next: null },
  );
});
afterEach(() => {
  vi.useRealTimers();
  client.clear();
});

describe("useLiveList", () => {
  it("polls the first page while Live", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.pages).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenLastCalledWith(undefined);
  });

  it("Load more pauses Live, so older pages are never re-read on a timer", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.pages).toHaveLength(2));
    expect(result.current.live).toBe(false);
    const calls = fetchPage.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3));
    expect(fetchPage).toHaveBeenCalledTimes(calls);
  });

  it("turning Live back on trims to the first page, then polls it alone", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.pages).toHaveLength(2));
    act(() => result.current.setLive(true));
    expect(result.current.pages).toHaveLength(1);
    fetchPage.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 10));
    expect(fetchPage.mock.calls).toEqual([[undefined]]);
  });
});
