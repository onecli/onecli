import { describe, expect, it } from "vitest";

import { applySkillBodyEdit } from "./skill-body-edit";

describe("applySkillBodyEdit (skill_update in place)", () => {
  const body = "# Release\n\n## After deploy\n- Run smoke tests\n- Clean up";

  it("replaces the one match, then appends at the end", () => {
    expect(
      applySkillBodyEdit(body, {
        edits: [
          {
            find: "- Run smoke tests",
            replace: "- Run smoke tests\n- Tag the release",
          },
        ],
        append: "## Notes\nKeep it.",
      }),
    ).toBe(
      "# Release\n\n## After deploy\n- Run smoke tests\n- Tag the release\n- Clean up\n\n## Notes\nKeep it.",
    );
  });

  it("applies edits in order, each against the previous result", () => {
    expect(
      applySkillBodyEdit("a b", {
        edits: [
          { find: "a", replace: "c" },
          { find: "c b", replace: "done" },
        ],
      }),
    ).toBe("done");
  });

  it("refuses a find that misses, or that matches twice (overlaps count)", () => {
    expect(() =>
      applySkillBodyEdit(body, { edits: [{ find: "nope", replace: "" }] }),
    ).toThrow("is not in the skill");
    expect(() =>
      applySkillBodyEdit("x x", { edits: [{ find: "x", replace: "y" }] }),
    ).toThrow("occurs more than once");
    // "aa" sits in "aaa" twice, overlapping: ambiguous, never "once".
    expect(() =>
      applySkillBodyEdit("aaa", { edits: [{ find: "aa", replace: "b" }] }),
    ).toThrow("occurs more than once");
  });

  it("refuses a result that is empty or over the one body limit", () => {
    expect(() =>
      applySkillBodyEdit("only", { edits: [{ find: "only", replace: "" }] }),
    ).toThrow("empty");
    expect(() =>
      applySkillBodyEdit("x".repeat(119_990), { append: "y".repeat(20) }),
    ).toThrow("limited to 120,000");
  });

  it("grows a long body past the old 24,000 limit", () => {
    const long = "x".repeat(46_000);
    expect(applySkillBodyEdit(long, { append: "- one more" }).length).toBe(
      46_000 + 2 + 10,
    );
  });

  it("stays linear on input that is quadratic for a naive search", () => {
    // A run of one character with a single other one in the middle of the
    // find: indexOf compares most of the find at every position of the body
    // (about a third of a second here); the linear search does not.
    const half = "a".repeat(12_000);
    const started = performance.now();
    expect(() =>
      applySkillBodyEdit("a".repeat(120_000), {
        edits: [{ find: `${half}b${half}`, replace: "" }],
      }),
    ).toThrow("is not in the skill");
    expect(performance.now() - started).toBeLessThan(100);
  });
});
