// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { LostChannelConnectionItem } from "@/lib/api/channel-alerts";

const scope = vi.hoisted(() => ({
  inWorkspace: true,
  workspaceId: "ws-1" as string | undefined,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/w/ws-1/agents/a" }));
vi.mock("@/lib/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/navigation")>()),
  hasWorkspaceContext: () => scope.inWorkspace,
}));
vi.mock("@/lib/api-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-fetch")>()),
  getWorkspaceId: () => scope.workspaceId,
}));

const alert = (id: string, lostAt: string): LostChannelConnectionItem => ({
  id,
  agentId: `agent-${id}`,
  agentName: `Agent ${id}`,
  provider: "slack",
  lostAt,
});
let served: LostChannelConnectionItem[] = [];
const fetched = vi.fn();
vi.mock("@/lib/api/channel-alerts", () => ({
  listChannelAlerts: async (workspaceId: string) => {
    fetched(workspaceId);
    return served;
  },
}));

const { useChannelAlerts, dismissChannelAlert } =
  await import("./use-channel-alerts");

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

afterEach(() => {
  window.localStorage.clear();
  scope.inWorkspace = true;
  scope.workspaceId = "ws-1";
  fetched.mockClear();
});

describe("useChannelAlerts", () => {
  it("an alert acted on leaves the bell; others stay", async () => {
    const a = alert("a", "2026-10-27T10:00:00.000Z");
    const b = alert("b", "2026-10-28T10:00:00.000Z");
    served = [a, b];
    const { result } = renderHook(() => useChannelAlerts(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(2));

    act(() => dismissChannelAlert(a));
    await waitFor(() =>
      expect(result.current.data?.map((i) => i.id)).toEqual(["b"]),
    );
  });

  it("the same agent losing its connection AGAIN alerts again", async () => {
    const first = alert("a", "2026-10-27T10:00:00.000Z");
    dismissChannelAlert(first);
    served = [alert("a", "2026-10-29T09:00:00.000Z")];
    const { result } = renderHook(() => useChannelAlerts(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
  });

  it("a corrupted stored list shows every alert instead of crashing", async () => {
    window.localStorage.setItem(
      "onecli.channel-alerts.seen",
      '{"not":"a list"}',
    );
    served = [alert("a", "2026-10-27T10:00:00.000Z")];
    const { result } = renderHook(() => useChannelAlerts(), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    // Dismissing still works, and rewrites a clean list.
    act(() => dismissChannelAlert(served[0]!));
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(
      JSON.parse(window.localStorage.getItem("onecli.channel-alerts.seen")!),
    ).toEqual(["a@2026-10-27T10:00:00.000Z"]);
  });

  it("remembers at most the newest 200 dismissals", () => {
    for (let i = 0; i < 205; i++) {
      dismissChannelAlert(alert(`p${i}`, "2026-10-27T10:00:00.000Z"));
    }
    const stored: string[] = JSON.parse(
      window.localStorage.getItem("onecli.channel-alerts.seen")!,
    );
    expect(stored).toHaveLength(200);
    expect(stored[0]).toBe("p5@2026-10-27T10:00:00.000Z");
    expect(stored.at(-1)).toBe("p204@2026-10-27T10:00:00.000Z");
  });

  it("asks nothing outside a workspace", async () => {
    served = [alert("a", "2026-10-27T10:00:00.000Z")];
    // A positive control first: inside a workspace it asks for that one.
    const inside = renderHook(() => useChannelAlerts(), { wrapper });
    await waitFor(() => expect(inside.result.current.data).toHaveLength(1));
    expect(fetched).toHaveBeenCalledWith("ws-1");
    inside.unmount();
    fetched.mockClear();

    for (const [inWorkspace, workspaceId] of [
      [false, "ws-1"],
      [true, undefined],
    ] as const) {
      scope.inWorkspace = inWorkspace;
      scope.workspaceId = workspaceId;
      const { result, unmount } = renderHook(() => useChannelAlerts(), {
        wrapper,
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(result.current.data).toBeUndefined();
      unmount();
    }
    expect(fetched).not.toHaveBeenCalled();
  });
});
