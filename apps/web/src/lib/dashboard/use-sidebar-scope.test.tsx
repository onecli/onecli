// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * The sidebar's URL scope. The case that matters: a URL that names no org
 * and no workspace (`/account/*` before its redirect lands) gets NO org nav.
 * `getNavItems` with no org would build rows at bare `/workspaces`,
 * `/skills` and the like, which are not routes: the sidebar rendered them,
 * the router prefetched each one, and every prefetch 404ed.
 */

const state = vi.hoisted(() => {
  const initial: {
    pathname: string;
    isAdmin: boolean | undefined;
    membershipAsked: boolean[];
  } = { pathname: "/account/preferences", isAdmin: true, membershipAsked: [] };
  return initial;
});

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}));
vi.mock("@/hooks/use-instance", () => ({
  useInstance: () => ({ edition: "cloud", entitled: true, version: "t" }),
}));
vi.mock("@/hooks/use-hosted-availability", () => ({
  useHostedAvailability: () => ({ hosted: true, runner: true }),
}));
vi.mock("@/lib/agents/availability", () => ({
  showsHostedSurface: () => true,
}));
// The cached membership read the top bar shares; `undefined` is "not known
// yet".
vi.mock("@/hooks/use-org", () => ({
  useOrgMembership: (enabled = true) => {
    state.membershipAsked.push(enabled);
    return {
      data:
        state.isAdmin === undefined ? undefined : { isAdmin: state.isAdmin },
    };
  },
}));
vi.mock("@/lib/settings-modal/use-settings-href", () => ({
  useSettingsHref: () => (page: string) => `?settings=${page}`,
}));

const { useSidebarScope } = await import("./use-sidebar-scope");

const urls = (items: ReturnType<typeof useSidebarScope>["navItems"]) =>
  items.map((i) => i.url);

describe("useSidebarScope", () => {
  beforeEach(() => {
    state.isAdmin = true;
    state.membershipAsked.length = 0;
  });

  // The account's page names no org: the membership read has nothing to
  // ask about there, and for a viewer with no org at all it would 401.
  it("asks about membership only on a URL that names an org", () => {
    for (const [pathname, asked] of [
      ["/account", false],
      ["/account/preferences", false],
      ["/w/ws1/agents/ag1/chat", true],
      ["/org/o1/skills", true],
    ] as const) {
      state.pathname = pathname;
      state.membershipAsked.length = 0;
      renderHook(() => useSidebarScope());
      expect(state.membershipAsked.at(-1), pathname).toBe(asked);
    }
  });

  it("builds no org nav while no org is known", () => {
    state.pathname = "/account/preferences";
    const { result } = renderHook(() => useSidebarScope());
    expect(result.current.orgId).toBeNull();
    expect(result.current.workspaceId).toBeUndefined();
    expect(urls(result.current.navItems)).toEqual([]);
    expect(result.current.workspacesUrl).toBe("/");
  });

  // The sidebar keys its rows by URL, and several org pages open one modal
  // page: two rows that land on the same href would collide (and show twice).
  it("never offers two rows that open the same page", () => {
    state.pathname = "/org/org-1/workspaces";
    const { result } = renderHook(() => useSidebarScope());
    const links = urls(result.current.navItems);
    expect(new Set(links).size).toBe(links.length);
  });

  it("scopes the org nav to the org in the URL", () => {
    state.pathname = "/org/org-1/workspaces";
    const { result } = renderHook(() => useSidebarScope());
    expect(result.current.orgId).toBe("org-1");
    const links = urls(result.current.navItems);
    expect(links.length).toBeGreaterThan(0);
    for (const url of links) {
      expect(
        url.startsWith("/org/org-1/") || url.startsWith("?settings="),
      ).toBe(true);
    }
  });

  // Fail closed: a member, or a viewer whose membership has not answered
  // yet, sees only the allowlisted org rows; an admin sees the rest.
  it("shows members, and viewers not known yet, only the workspaces row", () => {
    state.pathname = "/org/org-1/workspaces";
    state.isAdmin = false;
    const member = renderHook(() => useSidebarScope()).result.current;
    expect(urls(member.navItems)).toEqual(["/org/org-1/workspaces"]);

    state.isAdmin = undefined;
    const pending = renderHook(() => useSidebarScope()).result.current;
    expect(urls(pending.navItems)).toEqual(["/org/org-1/workspaces"]);

    state.isAdmin = true;
    const admin = renderHook(() => useSidebarScope()).result.current;
    expect(urls(admin.navItems).length).toBeGreaterThan(1);
  });

  // A workspace URL names no org: the layout announces it, and the sidebar
  // reads it even when the announcement came before it mounted.
  it("takes a workspace URL's org from the layout's announcement", () => {
    state.pathname = "/w/ws-1/agents/ag-1/chat";
    window.dispatchEvent(
      new CustomEvent("onecli:workspace-context", {
        detail: { workspaceId: "ws-1", organizationId: "org-9" },
      }),
    );
    const { result } = renderHook(() => useSidebarScope());
    expect(result.current.orgId).toBe("org-9");
    expect(result.current.workspacesUrl).toContain("org-9");
  });
});
