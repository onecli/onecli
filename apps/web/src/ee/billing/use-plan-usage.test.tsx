// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The create gates' quota, read off the plan usage the header already
 * caches. Cloud edition (billing on), so the usage query actually runs.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

const getPlanUsage = vi.hoisted(() => vi.fn());
vi.mock("./api-request-actions", () => ({ getPlanUsage }));
vi.mock("next/navigation", () => ({ usePathname: () => "/w/ws-1/agents" }));

const { useResourceQuota } = await import("./use-plan-usage");

const usage = (agents: { current: number; limit: number }) => ({
  plan: "pro",
  organizationId: "org-1",
  organizationName: "Acme",
  resources: [{ name: "Agents", ...agents }],
});

const renderQuota = (name: string) =>
  renderHook(() => useResourceQuota(name), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>
        {children}
      </QueryClientProvider>
    ),
  });

beforeEach(() => getPlanUsage.mockReset());

describe("useResourceQuota", () => {
  it("is null until usage loads, so a gate never blocks on a guess", async () => {
    getPlanUsage.mockResolvedValue(usage({ current: 3, limit: 3 }));
    const { result } = renderQuota("Agents");
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.atLimit).toBe(true));
  });

  it("is at the limit exactly when the count reaches it", async () => {
    getPlanUsage.mockResolvedValue(usage({ current: 3, limit: 3 }));
    const { result } = renderQuota("Agents");
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual({
      current: 3,
      limit: 3,
      plan: "pro",
      atLimit: true,
      organizationId: "org-1",
    });
  });

  it("is under the limit below it, and never at an unlimited one", async () => {
    getPlanUsage.mockResolvedValue(usage({ current: 2, limit: 3 }));
    const below = renderQuota("Agents");
    await waitFor(() => expect(below.result.current?.atLimit).toBe(false));

    getPlanUsage.mockResolvedValue(usage({ current: 99, limit: Infinity }));
    const unlimited = renderQuota("Agents");
    await waitFor(() => expect(unlimited.result.current?.atLimit).toBe(false));
  });

  it("treats a resource the plan does not list as unlimited", async () => {
    getPlanUsage.mockResolvedValue(usage({ current: 1, limit: 1 }));
    const { result } = renderQuota("Secrets");
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.atLimit).toBe(false);
    expect(result.current?.limit).toBe(Infinity);
  });
});
