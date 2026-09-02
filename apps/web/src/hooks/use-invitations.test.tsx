// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Onboarding's batch invite is one route call per address with a
 * partial-success summary: an address the server refuses (already a member,
 * seat cap) must not sink the rest of the batch, and every call must carry
 * the boot-resolved workspace scope the onboarding URL doesn't have.
 */

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/api", () => ({ invitations: { create } }));

import { ApiError } from "@/lib/api/client";

const { useInviteTeammates } = await import("./use-invitations");

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => create.mockReset());

describe("useInviteTeammates", () => {
  it("aggregates partial failure instead of failing the batch, keeping the refusal status", async () => {
    create
      .mockResolvedValueOnce({ id: "i1", joinUrl: "u", emailed: true })
      .mockRejectedValueOnce(new ApiError("Insufficient permissions", 403))
      .mockResolvedValueOnce({ id: "i2", joinUrl: "u", emailed: true })
      .mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useInviteTeammates(), { wrapper });
    const summary = await result.current.mutateAsync({
      emails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"],
      workspaceId: "ws-1",
    });

    // Status survives so the caller can tell a permission wall (403) from a
    // retryable failure (null = network-level).
    expect(summary).toEqual({
      invited: 2,
      failed: [
        { email: "b@x.com", status: 403 },
        { email: "d@x.com", status: null },
      ],
    });
    // Member role and explicit workspace scope on every call — the route's
    // admin gate, seat cap and audit trail all key off that scope.
    expect(create).toHaveBeenCalledTimes(4);
    expect(create).toHaveBeenNthCalledWith(
      1,
      { email: "a@x.com", role: "member" },
      { workspaceId: "ws-1" },
    );
  });
});
