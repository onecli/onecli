// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTurnstile, type TurnstileHandle } from "./use-turnstile";

/**
 * A stand-in for Cloudflare's browser API: records render parameters so a
 * test can play the widget's callbacks (solve, fail, challenge) by hand.
 */
const fakeTurnstile = () => {
  let params: Turnstile.RenderParameters | undefined;
  const api = {
    render: vi.fn((_: unknown, p?: Turnstile.RenderParameters) => {
      params = p;
      return "widget-1";
    }),
    reset: vi.fn(),
    remove: vi.fn(),
    isExpired: vi.fn(() => false),
    ready: vi.fn(),
    execute: vi.fn(),
    getResponse: vi.fn(),
  } satisfies Turnstile.Turnstile;
  return { api, params: () => params! };
};

let fake: ReturnType<typeof fakeTurnstile>;

vi.mock("./turnstile-script", () => ({
  loadTurnstile: () => Promise.resolve(fake.api),
}));

const OPTIONS: { siteKey: string; action: string; theme: Turnstile.Theme } = {
  siteKey: "0xSITE",
  action: "signup",
  theme: "auto",
};

/** Mount the hook with a real container, then let the script load settle. */
const mountWidget = async (options = OPTIONS) => {
  const hook = renderHook(() => useTurnstile(options));
  await act(async () => {
    hook.result.current.containerRef(document.createElement("div"));
  });
  return hook;
};

beforeEach(() => {
  fake = fakeTurnstile();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTurnstile", () => {
  it("renders a Managed widget bound to the action, invisible until needed", async () => {
    await mountWidget();
    expect(fake.api.render).toHaveBeenCalledTimes(1);
    expect(fake.params()).toMatchObject({
      sitekey: "0xSITE",
      action: "signup",
      appearance: "interaction-only",
      "response-field": false,
    });
  });

  it("returns the token immediately when the widget has already solved", async () => {
    const hook = await mountWidget();
    act(() => fake.params().callback?.("tok-1"));
    await expect(hook.result.current.getToken()).resolves.toBe("tok-1");
  });

  it("waits for a widget that is still solving", async () => {
    const hook = await mountWidget();
    const pending = hook.result.current.getToken();
    act(() => fake.params().callback?.("tok-late"));
    await expect(pending).resolves.toBe("tok-late");
  });

  it("resolves undefined (never throws) when the widget errors", async () => {
    const hook = await mountWidget();
    const pending = hook.result.current.getToken();
    act(() => {
      fake.params()["error-callback"]?.("300030");
    });
    await expect(pending).resolves.toBeUndefined();
    // And later calls do not hang on a failed widget.
    await expect(hook.result.current.getToken()).resolves.toBeUndefined();
  });

  it("gives up on a silent widget after a bounded wait", async () => {
    vi.useFakeTimers();
    const hook = await mountWidget();
    const pending = hook.result.current.getToken();
    await act(async () => {
      vi.advanceTimersByTime(16_000);
    });
    await expect(pending).resolves.toBeUndefined();
  });

  it("waits longer while the visitor is completing a challenge", async () => {
    vi.useFakeTimers();
    const hook = await mountWidget();
    act(() => fake.params()["before-interactive-callback"]?.());
    expect(hook.result.current.needsInteraction).toBe(true);
    const pending = hook.result.current.getToken();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    act(() => fake.params().callback?.("tok-human"));
    await expect(pending).resolves.toBe("tok-human");
    expect(hook.result.current.needsInteraction).toBe(false);
  });

  it("never hands out an expired token", async () => {
    const hook = await mountWidget();
    act(() => fake.params().callback?.("tok-old"));
    fake.api.isExpired.mockReturnValue(true);
    const pending = hook.result.current.getToken();
    act(() => fake.params().callback?.("tok-fresh"));
    await expect(pending).resolves.toBe("tok-fresh");
  });

  it("consume() forgets the token and resets the widget for a fresh one", async () => {
    const hook = await mountWidget();
    act(() => fake.params().callback?.("tok-used"));
    act(() => hook.result.current.consume());
    expect(fake.api.reset).toHaveBeenCalledWith("widget-1");
    const pending = hook.result.current.getToken();
    act(() => fake.params().callback?.("tok-next"));
    await expect(pending).resolves.toBe("tok-next");
  });

  it("does nothing without a sitekey: no widget, no token", async () => {
    const hook = await mountWidget({ ...OPTIONS, siteKey: "" });
    expect(fake.api.render).not.toHaveBeenCalled();
    await expect(hook.result.current.getToken()).resolves.toBeUndefined();
  });

  it("removes the widget on unmount", async () => {
    const hook = await mountWidget();
    hook.unmount();
    expect(fake.api.remove).toHaveBeenCalledWith("widget-1");
  });

  it("keeps the solved widget (and its token) when the theme changes", async () => {
    const hook = renderHook<TurnstileHandle, { theme: Turnstile.Theme }>(
      ({ theme }) => useTurnstile({ ...OPTIONS, theme }),
      { initialProps: { theme: "light" } },
    );
    await act(async () => {
      hook.result.current.containerRef(document.createElement("div"));
    });
    act(() => fake.params().callback?.("tok-kept"));
    hook.rerender({ theme: "dark" });
    expect(fake.api.render).toHaveBeenCalledTimes(1);
    expect(fake.api.remove).not.toHaveBeenCalled();
    await expect(hook.result.current.getToken()).resolves.toBe("tok-kept");
  });
});
