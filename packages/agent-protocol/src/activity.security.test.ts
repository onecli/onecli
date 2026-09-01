import { describe, expect, it } from "vitest";
import { ACTIVITY_TEXT_MAX, activityForReasoning } from "./activity";

/**
 * ADVERSARIAL INPUT — the derivation is the only thing between
 * sandbox-controlled model text and two user-facing surfaces (the operator's
 * browser and a Slack thread). A page the agent reads can influence this
 * text, so the invariants below are a security boundary, not formatting
 * taste: whatever goes in, what comes out is ONE short line of inert
 * characters.
 *
 * Consumers still render it as TEXT (JSX child / Slack form field, never
 * markdown, never a block-kit string) — this is defense in depth, not the
 * only defense.
 */
describe("the activity line under hostile input", () => {
  const hostile: [string, string][] = [
    ["script tag", "<script>alert(1)</script>"],
    ["markdown javascript: link", "[click](javascript:alert(1))"],
    ["html attribute handler", "<img src=x onerror=alert(1)>"],
    ["markdown flood", "*".repeat(5_000)],
    ["NUL byte", "a\u0000b"],
    ["line separator", "line1\u2028line2"],
    ["length bomb", "x".repeat(100_000)],
    ["RTL override", "\u202Egnirts desrever"],
    ["newline injection", "Reading\nSECOND LINE SHOULD NOT SHOW"],
  ];

  for (const [label, input] of hostile) {
    it(`stays one short inert line: ${label}`, () => {
      const out = activityForReasoning(input);
      if (out === null) return; // dropping it entirely is a fine outcome

      // BOUNDED — +1 for the ellipsis the cut may add.
      expect(out.length).toBeLessThanOrEqual(ACTIVITY_TEXT_MAX + 1);
      // SINGLE LINE — a second line could forge a separate status row.
      expect(out).not.toContain("\n");
      // INERT — no control characters, no Unicode line/paragraph separators
      // (U+2028 breaks a Slack status row and is rejected by the transcript
      // store), and no bidi override that could visually reorder the line.
      // Asserting the ABSENCE of control characters is the point of this
      // check, so the rule's own warning does not apply.
      // eslint-disable-next-line no-control-regex
      expect(out).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/);
      // NO BIDI SPOOFING — a planted U+202E visually reverses the rest of
      // the row, so sandbox text could display as something other than what
      // the transcript records.
      expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    });
  }

  it("drops bidi overrides rather than letting them reverse the row", () => {
    // MUTATION-PROOF: remove the bidi arms from `stripForStatus` and this
    // fails. Found during this change's own security pass — the first
    // implementation stripped control chars but let U+202E through.
    const out = activityForReasoning("\u202Egnirts desrever");
    expect(out).toBe("gnirts desrever");
    expect(out).not.toContain("\u202E");
  });

  it("does not resurrect a second line after stripping", () => {
    // The cut is on the FIRST line, so content after a newline can never
    // reach a surface — the property a "just truncate it" implementation
    // would quietly lose.
    expect(activityForReasoning("Reading\nSECRET")).toBe("Reading");
  });
});
