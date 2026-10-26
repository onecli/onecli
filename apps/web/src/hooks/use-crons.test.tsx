// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCron } from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { useSetCronEnabled } from "./use-crons";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  list: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    crons: { ...actual.crons, update: mocks.update, list: mocks.list },
  };
});
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

/** The optimistic pause switch end to end, on a real cache: the row flips
 * before the PATCH answers, a failure puts back exactly that row, and a
 * resume clears the auto-disable reason like the server does. */

const cron = (id: string, overrides: Partial<AgentCron> = {}): AgentCron => ({
  id,
  agentId: "ag-1",
  name: `Cron ${id}`,
  prompt: "p",
  schedule: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  disabledReason: null,
  nextFireAt: "2026-10-16T09:00:00Z",
  lastFiredAt: null,
  lastOutcome: null,
  consecutiveFailures: 0,
  createdAt: "2026-10-01T00:00:00Z",
  ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const setup = (rows: AgentCron[]) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = queryKeys.crons.agent("ag-1");
  qc.setQueryData(key, { crons: rows });
  // The settle refetch serves whatever the test last stored.
  mocks.list.mockImplementation(async () => qc.getQueryData(key));
  qc.getQueryCache().build(qc, {
    queryKey: key,
    queryFn: () => mocks.list(),
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useSetCronEnabled("ag-1"), { wrapper });
  const rowsNow = () =>
    qc.getQueryData<{ crons: AgentCron[] }>(key)?.crons ?? [];
  return { qc, result, rowsNow };
};

afterEach(() => vi.clearAllMocks());

describe("useSetCronEnabled", () => {
  it("flips the row before the server answers", async () => {
    const { result, rowsNow } = setup([cron("a"), cron("b")]);
    const patch = deferred<AgentCron>();
    mocks.update.mockReturnValueOnce(patch.promise);

    act(() => result.current.mutate({ cronId: "a", enabled: false }));
    await waitFor(() => expect(rowsNow()[0]?.enabled).toBe(false));
    expect(rowsNow()[1]?.enabled).toBe(true);

    patch.resolve(cron("a", { enabled: false }));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(rowsNow()[0]?.enabled).toBe(false);
  });

  it("a failure puts back only that row and names it", async () => {
    const { result, rowsNow } = setup([cron("a"), cron("b")]);
    mocks.update.mockRejectedValueOnce(new ApiError("Not allowed", 403));

    act(() => result.current.mutate({ cronId: "a", enabled: false }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(rowsNow().map((c) => c.enabled)).toEqual([true, true]);
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Couldn\'t pause "Cron a"',
      expect.objectContaining({ description: "Not allowed" }),
    );
  });

  it("resuming clears an auto-disable at once, like the server", async () => {
    const { result, rowsNow } = setup([
      cron("a", { enabled: false, disabledReason: "failures" }),
    ]);
    mocks.update.mockReturnValueOnce(deferred<AgentCron>().promise);

    act(() => result.current.mutate({ cronId: "a", enabled: true }));
    await waitFor(() => expect(rowsNow()[0]?.enabled).toBe(true));
    expect(rowsNow()[0]?.disabledReason).toBeNull();
  });
});
