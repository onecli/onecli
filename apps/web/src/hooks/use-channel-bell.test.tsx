// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingChannelApprovalItem } from "@/lib/api/channel-approvals";
import { ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { useDecideChannelAction } from "./use-approvals";

/** The bell's channel arm is optimistic like the gateway arm: a decided ask
 * leaves the list on click, the outcome is said when the server answers
 * (the row is gone by then), and a failed decision puts the ask back. */

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/w/ws-1/overview" }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/api/channels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/channels")>()),
  decideActionApproval: mocks.decide,
}));

const ask = (id: string): PendingChannelApprovalItem => ({
  kind: "action",
  id,
  agentId: "ag-1",
  agentName: "Donna",
  summary: `Send message ${id}`,
  offersAlwaysAllow: false,
  conversationId: null,
  createdAt: "2026-10-15T10:00:00Z",
  expiresAt: "2026-10-16T10:00:00Z",
  webhookChange: null,
  customConnection: null,
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

const setup = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = [...queryKeys.approvals.all(), "channel", "ws-1"];
  qc.setQueryData(key, [ask("a"), ask("b")]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useDecideChannelAction("ag-1"), {
    wrapper,
  });
  const ids = () =>
    (qc.getQueryData<PendingChannelApprovalItem[]>(key) ?? []).map((i) => i.id);
  return { result, ids };
};

afterEach(() => vi.clearAllMocks());

describe("useDecideChannelAction", () => {
  it("the ask leaves the bell before the server answers, then says the outcome", async () => {
    const { result, ids } = setup();
    const answer = deferred<{ kind: "decided"; status: "done" }>();
    mocks.decide.mockReturnValueOnce(answer.promise);

    act(() => result.current.mutate({ approvalId: "a", decision: "approve" }));
    await waitFor(() => expect(ids()).toEqual(["b"]));
    expect(mocks.toast.success).not.toHaveBeenCalled();

    answer.resolve({ kind: "decided", status: "done" });
    await waitFor(() =>
      expect(mocks.toast.success).toHaveBeenCalledWith("Approved and done."),
    );
  });

  it("a failed decision puts the ask back where it was, with the reason", async () => {
    const { result, ids } = setup();
    mocks.decide.mockRejectedValueOnce(new ApiError("Expired", 410));

    act(() => result.current.mutate({ approvalId: "a", decision: "reject" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(ids()).toEqual(["a", "b"]);
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Couldn't reject the request",
      expect.objectContaining({ description: "Expired" }),
    );
  });
});
