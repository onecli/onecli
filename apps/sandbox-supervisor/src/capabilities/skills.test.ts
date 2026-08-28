import { describe, expect, it } from "vitest";
import { skillsFragment } from "./skills";

/**
 * The loading mechanic is the load-bearing part: the harness's skill tool is
 * disabled and its own prompt lists skills as user slash-commands with no
 * paths, so "read the file yourself" — with the real directory — is the only
 * way a model can act on a skill (observed live: without it, the model
 * grepped the filesystem for the SKILL.md and mostly got blocked).
 */

describe("the skills fragment", () => {
  it("teaches the read-the-file loading mechanic with the harness's own skills dir", () => {
    // MUTATION-PROOF: drop the path template or hardcode a different dir and
    // this fails.
    const flat = skillsFragment(".agents/skills").body.replace(/\s+/g, " ");
    expect(flat).toContain("read .agents/skills/<name>/SKILL.md yourself");
  });

  it("overrides the slash-command framing — no loader tool exists", () => {
    const flat = skillsFragment(".agents/skills").body.replace(/\s+/g, " ");
    expect(flat).toContain("There is no loader tool");
    expect(flat).toContain("may frame skills as slash-commands");
  });

  it("keeps the read-only and brief-wins laws", () => {
    const flat = skillsFragment(".agents/skills").body.replace(/\s+/g, " ");
    expect(flat).toContain("do not try to edit them");
    expect(flat).toContain("the brief wins");
  });
});
