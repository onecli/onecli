// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * Every settings link opens the Settings modal over the page it is on:
 * `?settings=<page>` added to the current URL, the page's own query kept.
 */

const state = vi.hoisted(() => ({
  pathname: "/w/ws-1/agents/ag-1/chat",
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
}));

const { useSettingsHref } = await import("./use-settings-href");

describe("useSettingsHref", () => {
  it("opens the modal over the current page, keeping its query", () => {
    state.search = "draft=hello";
    const { result } = renderHook(() => useSettingsHref()("members"));
    expect(result.current).toBe(
      "/w/ws-1/agents/ag-1/chat?draft=hello&settings=members",
    );
  });

  it("replaces an open page with the new one", () => {
    state.search = "settings=apps";
    const { result } = renderHook(() => useSettingsHref()("billing"));
    expect(result.current).toBe("/w/ws-1/agents/ag-1/chat?settings=billing");
  });
});
