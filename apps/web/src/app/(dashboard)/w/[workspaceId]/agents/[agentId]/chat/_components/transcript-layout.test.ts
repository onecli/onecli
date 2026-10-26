import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PIN_SCROLL_MARGIN_PX,
  PINNED_ROW,
  TRANSCRIPT_PADDING,
} from "./transcript-layout";

/** Tailwind's spacing scale: one step is 0.25rem, 4px at the default size. */
const spacingPx = (prefix: "pt" | "pb") =>
  Number(
    new RegExp(`\\b${prefix}-([\\d.]+)\\b`).exec(TRANSCRIPT_PADDING)?.[1],
  ) * 4;

describe("transcript layout", () => {
  it("clears the viewport's bottom fade, so the newest item never looks cut off", () => {
    // MUTATION-TESTED: back to pb-6 (24px) under the 2rem (32px) fade and
    // the last card sits half-faded at the very bottom.
    const css = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../../../../../../../../../packages/ui/src/styles/globals.css",
      ),
      "utf8",
    );
    const fadeRem = Number(
      /scroll-fade-b[^}]*calc\(100% - ([\d.]+)rem\)/.exec(css)?.[1],
    );
    expect(fadeRem).toBeGreaterThan(0);
    expect(spacingPx("pb")).toBeGreaterThan(fadeRem * 16);
  });

  it("keeps the pin's pixel math in step with the padding classes", () => {
    // The scroller adds the top padding to the margin, and the pinned row's
    // height subtracts the bottom one: a padding change must move both.
    const peekPx = PIN_SCROLL_MARGIN_PX + spacingPx("pt");
    expect(PINNED_ROW).toContain(`${peekPx}px`);
    expect(PINNED_ROW).toContain(`${spacingPx("pb") / 16}rem`);
  });
});
