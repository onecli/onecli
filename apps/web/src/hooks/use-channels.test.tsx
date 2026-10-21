// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentChannelsView, ChannelPersonReach } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/**
 * The invalidation WIRING is the regression PR #845 hardened against: channel
 * mutations must sweep `agents.root()` — the scoped `agents.all()` misses the
 * sidebar's workspace-keyed rows (see keys.test.ts), leaving a stale Slack
 * mark. These tests pin the wiring itself, so a revert to `all()` fails here
 * even though both sweeps look plausible at the call site.
 */

vi.mock("@/lib/api", () => ({
  channels: {
    attach: vi.fn().mockResolvedValue({}),
    complete: vi.fn().mockResolvedValue({}),
    detach: vi.fn().mockResolvedValue({}),
    dismissPersonReach: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

const { channels } = await import("@/lib/api");
const {
  useAttachChannel,
  useCompleteChannel,
  useDetachChannel,
  useDismissPersonReach,
} = await import("./use-channels");

const setup = () => {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const sweptKeys = () => spy.mock.calls.map((call) => call[0]?.queryKey);
  return { wrapper, sweptKeys };
};

describe("channel mutations sweep the agents ROOT (not the scoped all())", () => {
  it("attach reaches the sidebar's for-workspace key via agents.root()", async () => {
    const { wrapper, sweptKeys } = setup();
    const { result } = renderHook(() => useAttachChannel("ag-1", "slack"), {
      wrapper,
    });
    await result.current.mutateAsync(undefined);
    expect(sweptKeys()).toContainEqual(queryKeys.agents.root());
    expect(sweptKeys()).toContainEqual(queryKeys.channels.all());
  });

  it("complete reaches it too", async () => {
    const { wrapper, sweptKeys } = setup();
    const { result } = renderHook(() => useCompleteChannel("ag-1", "slack"), {
      wrapper,
    });
    await result.current.mutateAsync({ botToken: "xoxb-test" });
    expect(sweptKeys()).toContainEqual(queryKeys.agents.root());
    expect(sweptKeys()).toContainEqual(queryKeys.channels.all());
  });

  it("detach reaches it too — the mark must also DISAPPEAR promptly", async () => {
    const { wrapper, sweptKeys } = setup();
    const { result } = renderHook(() => useDetachChannel("ag-1", "slack"), {
      wrapper,
    });
    await result.current.mutateAsync({ deleteRemote: false });
    expect(sweptKeys()).toContainEqual(queryKeys.agents.root());
    expect(sweptKeys()).toContainEqual(queryKeys.channels.all());
  });
});

describe("an instant reach dismiss that fails", () => {
  const person = (externalRef: string): ChannelPersonReach => ({
    externalRef,
    label: `@${externalRef}`,
    state: "approved",
    decidedAt: null,
  });
  const view = (people: ChannelPersonReach[]): AgentChannelsView => ({
    presences: [
      {
        provider: "slack",
        status: "active",
        transport: "events",
        externalId: "A0",
        identityRef: null,
        identityName: null,
        tenant: { externalId: "T0", name: null },
        managedBy: null,
        groupThreads: [],
        people,
      },
    ],
    posture: { transport: "events" },
    organizationId: "org-1",
    orgIntegrations: [],
    adapter: { online: true, lastSeenAt: null },
  });
  const refs = (qc: QueryClient) =>
    qc
      .getQueryData<AgentChannelsView>(queryKeys.channels.agent("ag-1"))
      ?.presences[0]?.people?.map((p) => p.externalRef);

  it("leaves on click, then returns to the SAME row, not the end", async () => {
    let reject: (e: Error) => void = () => undefined;
    vi.mocked(channels.dismissPersonReach).mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      }),
    );
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    qc.setQueryData(
      queryKeys.channels.agent("ag-1"),
      view([person("u-a"), person("u-b"), person("u-c")]),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useDismissPersonReach("ag-1", "slack"),
      {
        wrapper,
      },
    );

    let settled: Promise<unknown> = Promise.resolve();
    act(() => {
      settled = result.current
        .mutateAsync({ externalRef: "u-b" })
        .catch(() => undefined);
    });
    await vi.waitFor(() => expect(refs(qc)).toEqual(["u-a", "u-c"]));

    await act(async () => {
      reject(new Error("boom"));
      await settled;
    });
    expect(refs(qc)).toEqual(["u-a", "u-b", "u-c"]);
  });
});
