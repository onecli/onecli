// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invitation arm of the post-auth sync — the one place a signup can
 * succeed while the join it was for does not. What is worth pinning: the
 * suppressed sync (`fromInvitation=1`) actually rides the request, a refusal
 * surfaces the server's own words instead of navigating into an org-less
 * account, and a FAULT (whose envelope nests the message in an object) still
 * surfaces a string — an object here crashes the signup screen.
 */

const auth = {
  isAuthenticated: true,
  user: { id: "ba:u1", email: "invited@acme.test" },
  signOut: vi.fn(),
};

vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => auth,
}));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api-fetch", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { usePostAuthRedirect } from "./use-post-auth-redirect";

const response = (ok: boolean, status: number, body: unknown) =>
  ({ ok, status, json: async () => body }) as Response;

beforeEach(() => {
  apiFetch.mockReset();
  replace.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePostAuthRedirect — the invitation arm", () => {
  it("suppresses the personal-org bootstrap and surfaces a refusal's own words", async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.startsWith("/v1/auth/session")
        ? response(true, 200, {})
        : response(false, 400, {
            error: "The invitation was sent to a different email address.",
          }),
    );

    const { result } = renderHook(() =>
      usePostAuthRedirect({ invitationToken: "tok-1" }),
    );

    await waitFor(() => {
      expect(result.current).toMatch(/different email address/i);
    });
    // The sync that ran was the SUPPRESSED one — without the marker this
    // signup would have bootstrapped a personal org before the join.
    expect(apiFetch).toHaveBeenCalledWith("/v1/auth/session?fromInvitation=1");
    expect(replace).not.toHaveBeenCalled();
  });

  it("surfaces a string even when a fault nests the message in an object", async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.startsWith("/v1/auth/session")
        ? response(true, 200, {})
        : response(false, 500, {
            error: { message: "Something broke.", type: "internal" },
          }),
    );

    const { result } = renderHook(() =>
      usePostAuthRedirect({ invitationToken: "tok-1" }),
    );

    await waitFor(() => {
      expect(result.current).toBe("Something broke.");
    });
    expect(typeof result.current).toBe("string");
  });

  it("falls back to its own sentence when the refusal body is unreadable", async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.startsWith("/v1/auth/session")
        ? response(true, 200, {})
        : ({
            ok: false,
            status: 502,
            json: async () => {
              throw new Error("not json");
            },
          } as unknown as Response),
    );

    const { result } = renderHook(() =>
      usePostAuthRedirect({ invitationToken: "tok-1" }),
    );

    await waitFor(() => {
      expect(result.current).toMatch(/could not be redeemed/i);
    });
  });
});
