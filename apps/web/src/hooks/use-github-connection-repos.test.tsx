// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGitHubConnectionRepos } from "./use-github-app-share";
import { queryKeys } from "@/lib/api/keys";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  githubAppShare: { refreshConnectionRepositories: refresh },
}));
vi.mock("@/hooks/use-grants", () => ({ useInvalidateGrants: () => vi.fn() }));
vi.mock("@/hooks/use-org", () => ({
  useOrgMembership: () => ({ data: { isAdmin: true } }),
}));

afterEach(() => {
  vi.clearAllMocks();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

const setup = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 3, staleTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
};

describe("useGitHubConnectionRepos", () => {
  it("refreshes on reopening, scopes cache keys, and ignores incidental focus/reconnect", async () => {
    refresh.mockResolvedValue({
      available: ["acme/api"],
      selected: null,
      truncated: false,
    });
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ open }) => useGitHubConnectionRepos("conn", "workspace", open),
      { wrapper, initialProps: { open: true } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(refresh).toHaveBeenCalledWith("conn", "workspace");
    expect(
      queryKeys.connections.githubConnectionRepos("conn", "workspace"),
    ).not.toEqual(
      queryKeys.connections.githubConnectionRepos("conn", "organization"),
    );
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ open: false });
    rerender({ open: true });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it("does not retry an explicit refresh even when global queries retry", async () => {
    refresh.mockRejectedValue(new Error("Conflict"));
    const { wrapper } = setup();
    const { result } = renderHook(() => useGitHubConnectionRepos("conn"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
