// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "@/lib/api/approvals";
import { queryKeys } from "@/lib/api/keys";

const state = vi.hoisted(() => ({
  list: [] as { id: string }[],
  /** Ids the fake gateway refuses to decide. */
  failing: new Set<string>(),
  /** Runs just before a refused decision throws (e.g. a poll landing). */
  beforeRefusal: () => {},
  /** The gateway's long-poll is holding: no answer yet. */
  holding: false,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/w/ws-1/overview" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/navigation")>()),
  hasWorkspaceContext: () => true,
}));
vi.mock("@/lib/api/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/approvals")>()),
  // The gateway still lists the approval (its drop sits behind a long-poll).
  listPending: vi.fn(() =>
    state.holding ? new Promise(() => {}) : Promise.resolve(state.list),
  ),
  // Like the gateway: a delivered decision leaves the pending list.
  decide: vi.fn(async (id: string) => {
    if (state.failing.has(id)) {
      state.beforeRefusal();
      throw new Error("503");
    }
    state.list = state.list.filter((a) => a.id !== id);
    return "delivered";
  }),
}));

/** A fresh module per test: the gateway-clock estimate is module state. */
const load = async () => {
  vi.resetModules();
  return import("./use-approvals");
};

/** An approval created `ageMs` ago on a gateway clock `skewMs` behind ours. */
const approval = (
  id: string,
  {
    lifeMs,
    ageMs = 0,
    skewMs = 0,
  }: { lifeMs: number; ageMs?: number; skewMs?: number },
) => {
  const created = Date.now() - ageMs - skewMs;
  return {
    id,
    method: "POST",
    url: "https://x.test/",
    host: "x.test",
    path: "/",
    headers: {},
    agent: { id: "ag", name: "Ofer" },
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + lifeMs).toISOString(),
  } as PendingApproval;
};

const setup = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
};

afterEach(() => {
  vi.useRealTimers();
  state.failing = new Set();
  state.beforeRefusal = () => {};
  state.holding = false;
});

describe("usePendingApprovals", () => {
  it("drops an approval the moment its deadline passes, even while the gateway still lists it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { usePendingApprovals } = await load();
    state.list = [
      approval("soon", { lifeMs: 2_000 }),
      approval("later", { lifeMs: 60_000 }),
    ];
    const { result } = renderHook(() => usePendingApprovals(), setup());
    await vi.waitFor(() => expect(result.current.data).toHaveLength(2));

    await act(async () => {
      vi.advanceTimersByTime(2_200);
    });

    expect(result.current.data.map((a) => a.id)).toEqual(["later"]);
  });

  it("judges deadlines on the gateway's clock: a browser clock running ahead never drops a live request", async () => {
    // MUTATION-TESTED: comparing `expiresAt` to this browser's clock drops
    // this request at once, while the gateway still holds it for ~60s.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { usePendingApprovals } = await load();
    state.list = [approval("held", { lifeMs: 60_000, skewMs: 90_000 })];
    const { result } = renderHook(() => usePendingApprovals(), setup());
    await vi.waitFor(() => expect(result.current.data).toHaveLength(1));

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.data.map((a) => a.id)).toEqual(["held"]);
  });
});

describe("useDecideApprovals", () => {
  it("puts back only the requests whose decision failed, once each, and says which", async () => {
    const { usePendingApprovals, useDecideApprovals } = await load();
    const bad = approval("bad", { lifeMs: 60_000 });
    state.list = [approval("ok", { lifeMs: 60_000 }), bad];
    state.failing = new Set(["bad"]);
    const { client, wrapper } = setup();
    // A poll lands mid-click and already brings the refused one back; the
    // next one holds, so the list is what the rollback left.
    state.beforeRefusal = () => {
      client.setQueryData<PendingApproval[]>(
        queryKeys.approvals.list(),
        (old = []) => [...old, bad],
      );
      state.holding = true;
    };
    const { result } = renderHook(
      () => ({ list: usePendingApprovals(), decide: useDecideApprovals() }),
      { wrapper },
    );
    await vi.waitFor(() => expect(result.current.list.data).toHaveLength(2));

    let outcome: { failed: string[] } | undefined;
    await act(async () => {
      outcome = await result.current.decide.mutateAsync({
        ids: ["ok", "bad"],
        decision: "approve",
      });
    });

    expect(outcome?.failed).toEqual(["bad"]);
    const cached = client.getQueryData<PendingApproval[]>(
      queryKeys.approvals.list(),
    );
    expect(cached?.map((a) => a.id)).toEqual(["bad"]);
  });
});
