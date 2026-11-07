// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSharedGitHubInstallations } from "./use-github-app-share";

/** Sharing is an org-admin act: a member never fetches the installations
 * (the route would refuse), so every caller falls back to the install flow. */

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
}));
vi.mock("@/lib/api/client", () => ({
  apiGet: mocks.apiGet,
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

const INSTALLATION = { sourceConnectionId: "conn-src", account: "acme" };

const renderFor = (isAdmin: boolean) => {
  mocks.apiGet.mockImplementation(async (path) => {
    if (path === "/v1/org/membership") return { isAdmin };
    if (path.endsWith("/github-app/installations")) return [INSTALLATION];
    throw new Error(`unexpected GET ${path}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSharedGitHubInstallations("workspace"), {
    wrapper,
  });
};

afterEach(() => vi.clearAllMocks());

describe("useSharedGitHubInstallations", () => {
  it("offers an org admin the org's installations", async () => {
    const { result } = renderFor(true);
    await waitFor(() => expect(result.current.data).toEqual([INSTALLATION]));
  });

  it("never fetches them for a member", async () => {
    const { result } = renderFor(false);
    await waitFor(() =>
      expect(mocks.apiGet).toHaveBeenCalledWith("/v1/org/membership"),
    );
    expect(result.current.data).toBeUndefined();
    expect(mocks.apiGet).not.toHaveBeenCalledWith(
      expect.stringContaining("/installations"),
    );
  });
});
