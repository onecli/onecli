// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { SettingsModalProvider } from "./modal-context";
import { useConnectionsHref } from "./use-connections-href";

/**
 * The connections components build every link through this hook, so
 * where it points IS whether an app's detail opens inside the Settings
 * modal or leaves it: on a route page, the route (unchanged); inside the
 * modal, the page-local params over the URL beneath.
 */

const state = vi.hoisted(() => ({
  pathname: "/w/ws-1/connections",
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
}));

const inModal = (page: "apps" | "shared-apps") => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <SettingsModalProvider
      value={{ page, organizationId: "org-1", workspaceId: "ws-1" }}
    >
      {children}
    </SettingsModalProvider>
  );
  return Wrapper;
};

describe("useConnectionsHref", () => {
  it("builds the route on a route page, basePath first", () => {
    state.pathname = "/w/ws-1/connections";
    const { result } = renderHook(() => useConnectionsHref());
    expect(result.current("/apps/gmail")).toBe(
      "/w/ws-1/connections/apps/gmail",
    );
    expect(result.current()).toBe("/w/ws-1/connections");

    const org = renderHook(() =>
      useConnectionsHref("/org/org-1/settings/global-connections"),
    );
    expect(org.result.current("/apps/gmail?connected=c1")).toBe(
      "/org/org-1/settings/global-connections/apps/gmail?connected=c1",
    );
  });

  it("stays inside the modal, on the modal's page, whatever the route beneath", () => {
    state.pathname = "/w/ws-1/agents/ag-1/chat";
    state.search = "settings=apps&tab=connected&draft=hi";
    const { result } = renderHook(() => useConnectionsHref(), {
      wrapper: inModal("apps"),
    });
    expect(result.current("/apps/gmail")).toBe(
      "/w/ws-1/agents/ag-1/chat?settings=apps&draft=hi&app=gmail",
    );
    expect(result.current("/vaults/onepassword")).toBe(
      "/w/ws-1/agents/ag-1/chat?settings=apps&draft=hi&vault=onepassword",
    );
    expect(result.current()).toBe(
      "/w/ws-1/agents/ag-1/chat?settings=apps&draft=hi",
    );
  });

  it("ignores basePath inside the modal: the shared page is a modal page too", () => {
    state.pathname = "/w/ws-1/agents/ag-1/chat";
    state.search = "settings=shared-apps";
    const { result } = renderHook(
      () => useConnectionsHref("/org/org-1/settings/global-connections"),
      { wrapper: inModal("shared-apps") },
    );
    expect(result.current("/apps/gmail?connected=c1")).toBe(
      "/w/ws-1/agents/ag-1/chat?settings=shared-apps&app=gmail&connected=c1",
    );
  });
});
