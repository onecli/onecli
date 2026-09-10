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
 *
 * Two more arms sit beside it. A join link PARKED in `inviteCallbackUrl` (by
 * the /join page when someone was signed out, or signed in as the wrong
 * account and switched) has to resume after the sync — with the same
 * bootstrap suppression, or the resumed join would hand them a personal org
 * first. And a successful redeem has to land INSIDE the joined organization,
 * not on `/`, which resolves the default-org cookie and drops them back in
 * whatever org they were in before.
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

// `window.location.assign` is a full navigation the hook reaches for when
// the page below must re-render for a NEW membership or session; jsdom's own
// implementation only logs "not implemented", so swap the object for a spy.
const assign = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  apiFetch.mockReset();
  replace.mockReset();
  assign.mockReset();
  localStorage.clear();
  Object.defineProperty(window, "location", {
    value: { ...realLocation, assign },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    value: realLocation,
    writable: true,
    configurable: true,
  });
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

  it("lands inside the organization it just joined, not on the home redirect", async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.startsWith("/v1/auth/session")
        ? response(true, 200, {})
        : response(true, 200, {
            organizationId: "org-joined",
            organizationName: "Acme",
          }),
    );

    renderHook(() => usePostAuthRedirect({ invitationToken: "tok-1" }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/org/org-joined/workspaces");
    });
    // A full navigation, not a router push: the server components below
    // rendered for someone who was not a member yet.
    expect(replace).not.toHaveBeenCalled();
  });

  it("falls back to / when the accept response carries no organization id", async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.startsWith("/v1/auth/session")
        ? response(true, 200, {})
        : response(true, 200, {}),
    );

    renderHook(() => usePostAuthRedirect({ invitationToken: "tok-1" }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/");
    });
  });
});

describe("usePostAuthRedirect — a parked join link", () => {
  it("resumes the parked /join URL with a suppressed sync, and clears the slot", async () => {
    localStorage.setItem("inviteCallbackUrl", "/join?token=tok-parked");
    apiFetch.mockResolvedValue(response(true, 200, { workspaceId: "ws-1" }));

    renderHook(() => usePostAuthRedirect());

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/join?token=tok-parked");
    });
    // Joining someone else's org: the sync must NOT bootstrap a personal one.
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/v1/auth/session?fromInvitation=1");
    // Consumed exactly once — a later plain sign-in must not replay it.
    expect(localStorage.getItem("inviteCallbackUrl")).toBeNull();
    // A full navigation: /join is a server component that has to see the
    // NEW session, not anything rendered for the old one.
    expect(replace).not.toHaveBeenCalled();
    // Nothing was redeemed from here — the /join page owns that step.
    expect(apiFetch).not.toHaveBeenCalledWith(
      "/v1/invitations/accept",
      expect.anything(),
    );
  });

  it("keeps the slot when the sync fails, so the join survives a retry", async () => {
    localStorage.setItem("inviteCallbackUrl", "/join?token=tok-parked");
    apiFetch.mockResolvedValue(response(false, 500, {}));

    const { result } = renderHook(() => usePostAuthRedirect());

    await waitFor(() => {
      expect(result.current).toMatch(/did not finish/i);
    });
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem("inviteCallbackUrl")).toBe(
      "/join?token=tok-parked",
    );
  });

  it("an invited signup's own token wins over a stale parked link", async () => {
    // Both can coexist: someone parked a link, abandoned it, and later
    // registered straight from a (possibly different) invitation email.
    // The URL they are on is the intent; the slot is left for its own flow.
    localStorage.setItem("inviteCallbackUrl", "/join?token=tok-stale");
    apiFetch.mockImplementation(async (url: string) =>
      url.startsWith("/v1/auth/session")
        ? response(true, 200, {})
        : response(true, 200, { organizationId: "org-fresh" }),
    );

    renderHook(() => usePostAuthRedirect({ invitationToken: "tok-fresh" }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/org/org-fresh/workspaces");
    });
    expect(apiFetch).toHaveBeenCalledWith("/v1/auth/session?fromInvitation=1");
    expect(apiFetch).toHaveBeenCalledWith(
      "/v1/invitations/accept",
      expect.objectContaining({
        body: JSON.stringify({ token: "tok-fresh" }),
      }),
    );
    expect(assign).not.toHaveBeenCalledWith("/join?token=tok-stale");
    expect(localStorage.getItem("inviteCallbackUrl")).toBe(
      "/join?token=tok-stale",
    );
  });

  it("a plain sign-in with nothing parked takes the ordinary home route", async () => {
    apiFetch.mockResolvedValue(response(true, 200, { workspaceId: "ws-1" }));

    renderHook(() => usePostAuthRedirect());

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/w/ws-1/overview");
    });
    expect(apiFetch).toHaveBeenCalledWith("/v1/auth/session");
    expect(assign).not.toHaveBeenCalled();
  });
});
