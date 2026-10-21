// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { transitionDesktop } from "./desktop-transition";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("transitionDesktop", () => {
  it("commits directly when the browser does not support transitions", () => {
    const update = vi.fn();
    transitionDesktop(update);
    expect(update).toHaveBeenCalledOnce();
  });
  it("never requests animation when reduced motion is preferred", () => {
    const start = vi.fn();
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: start,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const update = vi.fn();
    try {
      transitionDesktop(update);
      expect(update).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, "startViewTransition");
    }
  });
  it("commits inside the browser snapshot callback and handles skipped animations", async () => {
    const update = vi.fn();
    const start = vi.fn((callback: () => void) => {
      expect(update).not.toHaveBeenCalled();
      callback();
      return { ready: Promise.reject(new Error("transition skipped")) };
    });
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: start,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    try {
      transitionDesktop(update);
      await Promise.resolve();
      expect(start).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledOnce();
    } finally {
      Reflect.deleteProperty(document, "startViewTransition");
    }
  });
});
