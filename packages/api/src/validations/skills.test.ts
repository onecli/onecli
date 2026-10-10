import { describe, expect, it } from "vitest";
import {
  createOrgSkillSchema,
  createSkillSchema,
  updateSkillSchema,
} from "./skills";

const skill = (files: { path: string; content: string }[]) => ({
  name: "release",
  description: "Cut a release",
  content: "Steps",
  files,
});

describe("skill files", () => {
  it("accepts files side by side and inside a folder", () => {
    expect(
      createSkillSchema.safeParse(
        skill([
          { path: "refs.md", content: "A" },
          { path: "refs/api.md", content: "B" },
          { path: "refs/cli.md", content: "C" },
        ]),
      ).success,
    ).toBe(true);
  });

  it("rejects a file whose path is the folder of another file", () => {
    // `refs` would have to be a file and a directory at once in the sandbox.
    const files = [
      { path: "refs", content: "A" },
      { path: "refs/api.md", content: "B" },
    ];
    expect(createSkillSchema.safeParse(skill(files)).success).toBe(false);
    expect(createOrgSkillSchema.safeParse(skill(files)).success).toBe(false);
    expect(updateSkillSchema.safeParse({ files }).success).toBe(false);
    // Order does not matter.
    expect(
      createSkillSchema.safeParse(skill([...files].reverse())).success,
    ).toBe(false);
  });
});
