// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

/**
 * A tab, search or filter inside the Settings modal rewrites the URL with a
 * shallow `history.replaceState`, never through the router: a router
 * replace re-renders the `@settings` slot on the server, so every click and
 * keystroke waited on a round trip before the page moved.
 */

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { useReplaceParam } = await import("./use-replace-param");

const at = (url: string) => window.history.replaceState(null, "", url);

afterEach(() => {
  at("/");
  vi.restoreAllMocks();
});

describe("useReplaceParam", () => {
  it("sets one param and keeps the rest, the open modal above all", () => {
    at("/w/ws/agents/ag/chat?draft=hi&settings=apps");
    const { result } = renderHook(() => useReplaceParam());
    result.current("tab", "llms");
    expect(window.location.pathname + window.location.search).toBe(
      "/w/ws/agents/ag/chat?draft=hi&settings=apps&tab=llms",
    );
  });

  it("clears a param, and leaves a bare path when nothing is left", () => {
    at("/w/ws/agents/ag/chat?tab=llms");
    const { result } = renderHook(() => useReplaceParam());
    result.current("tab", null);
    expect(window.location.pathname + window.location.search).toBe(
      "/w/ws/agents/ag/chat",
    );
  });

  // Two writes in one tick (Clear filters drops q and category) build on
  // each other, not on a render-time snapshot.
  it("composes writes made in the same tick", () => {
    at("/w/ws/x?settings=apps&q=git&category=dev");
    const { result } = renderHook(() => useReplaceParam());
    result.current("q", null);
    result.current("category", null);
    expect(window.location.search).toBe("?settings=apps");
  });

  it("replaces the entry and never asks the router", () => {
    at("/w/ws/x?settings=apps");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const pushState = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useReplaceParam());
    result.current("tab", "custom");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/w/ws/x?settings=apps&tab=custom",
    );
    expect(pushState).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });
});
