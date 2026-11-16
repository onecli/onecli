// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSmoothText } from "./use-smooth-text";

/**
 * The hook in a real React tree, with frames driven by fake timers: what the
 * reader would see, frame by frame.
 */
describe("useSmoothText", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
  });
  afterEach(() => vi.useRealTimers());

  const frames = (n: number) => {
    for (let i = 0; i < n; i++) {
      act(() => {
        vi.advanceTimersToNextFrame();
      });
    }
  };

  it("returns complete text untouched when it is not animating (history)", () => {
    const { result } = renderHook(() =>
      useSmoothText("Already here.", { animate: false, final: true }),
    );
    expect(result.current).toBe("Already here.");
  });

  it("reveals a streaming batch progressively, word by word", () => {
    const text = "one two three four five six seven eight nine ten";
    const { result } = renderHook(
      ({ target }) => useSmoothText(target, { animate: true, final: false }),
      { initialProps: { target: text } },
    );
    expect(result.current).toBe("");
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      frames(1);
      seen.push(result.current);
    }
    // Grew in several steps, never cut a word, never went backwards.
    expect(new Set(seen).size).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.startsWith(seen[i - 1]!)).toBe(true);
      const shown = seen[i]!;
      expect(
        shown === text || shown.endsWith(" ") || shown === "",
        `cut mid-word: ${JSON.stringify(shown)}`,
      ).toBe(true);
    }
  });

  it("catches up quickly once the text is final", () => {
    const draft = "word ".repeat(60).trim();
    const { result, rerender } = renderHook(
      ({ target, final }) => useSmoothText(target, { animate: true, final }),
      { initialProps: { target: draft, final: false } },
    );
    frames(3);
    expect(result.current.length).toBeLessThan(draft.length);
    rerender({ target: draft, final: true });
    // 250ms at 60fps is ~15 frames; give it a few more for rounding.
    frames(18);
    expect(result.current).toBe(draft);
  });

  it("snaps to a final text that is not an extension of the draft", () => {
    const { result, rerender } = renderHook(
      ({ target, final }) => useSmoothText(target, { animate: true, final }),
      { initialProps: { target: "The answer is four", final: false } },
    );
    frames(30);
    rerender({ target: "Corrected: it is 5.", final: true });
    frames(1);
    expect(result.current).toBe("Corrected: it is 5.");
  });

  it("shows everything at once under reduced motion", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMedia);
    const { result } = renderHook(() =>
      useSmoothText("All at once please.", { animate: true, final: false }),
    );
    expect(result.current).toBe("All at once please.");
    vi.unstubAllGlobals();
  });

  it("flows in an answer that lands whole in front of the reader", () => {
    // How an answer after tool calls usually arrives: one final text, no
    // deltas. Watched, it reads as arriving, not as a block popping in.
    const answer = "This is the whole answer, all at once. ".repeat(20).trim();
    const { result, rerender } = renderHook(
      ({ target, final }) => useSmoothText(target, { animate: true, final }),
      { initialProps: { target: "", final: false } },
    );
    rerender({ target: answer, final: true });
    frames(2);
    expect(result.current.length).toBeGreaterThan(0);
    expect(result.current.length).toBeLessThan(answer.length / 4);
    // All of it within the cap (~1.8 s, ~108 frames).
    frames(115);
    expect(result.current).toBe(answer);
  });

  it("still reveals under StrictMode's mount, unmount, mount", () => {
    // React runs effects twice in development. A cleanup that cancelled
    // the frame but kept its handle meant the loop never restarted, and
    // the answer stayed EMPTY on screen.
    const answer = "Shown under StrictMode, every word. ".repeat(10).trim();
    const { result } = renderHook(
      () => useSmoothText(answer, { animate: true, final: true }),
      { wrapper: StrictMode },
    );
    frames(130);
    expect(result.current).toBe(answer);
  });

  it("never shows a table as raw pipes while it forms", () => {
    const intro = "Compare:\n\n";
    const { result, rerender } = renderHook(
      ({ target, final }) => useSmoothText(target, { animate: true, final }),
      { initialProps: { target: `${intro}| Loud | Calm |`, final: false } },
    );
    frames(60);
    // Caught up with what arrived, but the header alone is held back.
    expect(result.current).toBe(intro);
    rerender({
      target: `${intro}| Loud | Calm |\n| --- | --- |\n| Tiring | Restful |`,
      final: true,
    });
    frames(30);
    expect(result.current).toBe(
      `${intro}| Loud | Calm |\n| --- | --- |\n| Tiring | Restful |`,
    );
  });

  it("releases held-back text when the final answer lands unchanged", () => {
    const text = "Compare:\n\n| A | B |";
    const { result, rerender } = renderHook(
      ({ final }) => useSmoothText(text, { animate: true, final }),
      { initialProps: { final: false } },
    );
    frames(40);
    expect(result.current).toBe("Compare:\n\n");
    rerender({ final: true });
    frames(20);
    expect(result.current).toBe(text);
  });

  it("flows in a whole answer the element MOUNTS with, too", () => {
    // The usual path: the answer's element appears with the final text
    // already in hand (nothing was streamed into it first).
    const answer = "Mounted with the whole answer in hand. ".repeat(20).trim();
    const { result } = renderHook(() =>
      useSmoothText(answer, { animate: true, final: true }),
    );
    expect(result.current).toBe("");
    frames(2);
    expect(result.current.length).toBeGreaterThan(0);
    expect(result.current.length).toBeLessThan(answer.length / 4);
    frames(115);
    expect(result.current).toBe(answer);
  });

  it("never animates in a tab nobody is looking at", () => {
    // Frames do not run in a hidden tab: coming back to an answer that then
    // starts flowing from nothing would replay what already arrived.
    const hidden = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { result, rerender } = renderHook(
      ({ target, final }) => useSmoothText(target, { animate: true, final }),
      { initialProps: { target: "Arrived", final: false } },
    );
    expect(result.current).toBe("Arrived");
    rerender({ target: "Arrived while away.", final: true });
    expect(result.current).toBe("Arrived while away.");
    hidden.mockRestore();
  });

  it("shows the rest at once if the tab is hidden mid-reveal", () => {
    const text = "word ".repeat(80).trim();
    const { result, rerender } = renderHook(
      ({ target, final }) => useSmoothText(target, { animate: true, final }),
      { initialProps: { target: text, final: false } },
    );
    frames(3);
    expect(result.current.length).toBeLessThan(text.length);
    const hidden = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    rerender({ target: `${text} done.`, final: true });
    expect(result.current).toBe(`${text} done.`);
    hidden.mockRestore();
  });
});
