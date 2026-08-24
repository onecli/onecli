// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  },
}));

const { useAttachChannel, useCompleteChannel, useDetachChannel } =
  await import("./use-channels");

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
