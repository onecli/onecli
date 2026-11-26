// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useNewestScheduleRun } from "./use-runs";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, runs: { ...actual.runs, list: mocks.list } };
});

const page = (...turnIds: string[]) => ({
  runs: turnIds.map((turnId) => ({ turnId })),
  nextBefore: null,
});

/** The Last run link asks for the newest run at click time: a run that
 * started since the previous click must be the one it opens. */
describe("useNewestScheduleRun", () => {
  it("asks the server on every call, for this schedule only", async () => {
    // The app's own default (query-provider.tsx): a cached answer would be
    // reused for 30 s, opening the previous run instead of the new one.
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000 } },
    });
    const { result } = renderHook(() => useNewestScheduleRun("ag-1", "cr-1"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });

    mocks.list.mockResolvedValueOnce(page("t-1"));
    expect(await result.current()).toBe("t-1");
    mocks.list.mockResolvedValueOnce(page("t-2", "t-1"));
    expect(await result.current()).toBe("t-2");
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenLastCalledWith({
      agentId: "ag-1",
      cronId: "cr-1",
    });

    mocks.list.mockResolvedValueOnce(page());
    expect(await result.current()).toBeNull();
  });
});
