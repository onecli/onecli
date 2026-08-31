import { describe, expect, it } from "vitest";
import { automationCaption } from "./mirror-posts";

/**
 * The automation caption. Its whole job is to LABEL a report, never to be
 * one: `turn.message` for a cron or watch fire is the platform's run
 * instruction — header, the agent's own stored prompt, then a recent-output
 * excerpt — and Slack used to post all of it (2026-08-31, live). The mirror
 * suite covers the posted shape end to end; these pin the cutting rules,
 * where the edge cases live.
 */
describe("the automation caption", () => {
  it("keeps a short header exactly as it is", () => {
    expect(automationCaption('Scheduled run "daily-check"')).toBe(
      'Scheduled run "daily-check"',
    );
  });

  it("takes only the first line of a multi-line run instruction", () => {
    const header = [
      '[Watch on process "CI watcher" fired: its output matched.]',
      "",
      "Then clean up: rm -rf /tmp/ocl3",
      "[Recent output:]",
      "RUNNING CI",
    ].join("\n");

    expect(automationCaption(header)).toBe(
      '[Watch on process "CI watcher" fired: its output matched.]',
    );
  });

  it("cuts a CRLF header at the carriage return, not through it", () => {
    // A stray \r would ride into Slack and render as a control character.
    expect(automationCaption("Scheduled run\r\nthe body")).toBe(
      "Scheduled run",
    );
  });

  it("clips an over-long line at a word boundary, with an ellipsis", () => {
    const caption = automationCaption(`${"alpha beta ".repeat(30)}omega`);

    expect(caption.endsWith("…")).toBe(true);
    // Bounded, and cut between words rather than through one.
    expect(caption.length).toBeLessThanOrEqual(121);
    expect(caption).not.toContain("alp…");
  });

  it("hard-cuts a single unbroken word rather than running past the cap", () => {
    // No space to fall back on: the word-boundary preference must not defeat
    // the bound itself.
    const caption = automationCaption("x".repeat(400));

    expect(caption.length).toBe(121);
    expect(caption.endsWith("…")).toBe(true);
  });

  it("never ends on a split surrogate pair", () => {
    // Emoji are two code units: cutting between them yields a lone high
    // surrogate, which renders as a replacement character. Same rule the
    // plain-answer degrade in this module already follows.
    const caption = automationCaption("😀".repeat(200));

    expect(/[\uD800-\uDBFF]$/.test(caption.slice(0, -1))).toBe(false);
  });

  it("is empty for an empty header, so nothing invents a label", () => {
    expect(automationCaption("")).toBe("");
    expect(automationCaption("\n\nbody only")).toBe("");
  });
});
