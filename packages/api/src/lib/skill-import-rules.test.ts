import { describe, expect, it } from "vitest";
import { SKILL_NAME_PATTERN } from "../validations/skills";
import {
  SKILL_LEAVE_OUT_RULES,
  skillCheckCommand,
  skillLeaveOutReason,
} from "./skill-import-rules";

describe("skillLeaveOutReason", () => {
  it("matches a folder name at any depth, in its exact case", () => {
    expect(
      skillLeaveOutReason("lib/vendor/__pycache__/m.cpython-312.pyc"),
    ).toBe("Generated file");
    expect(skillLeaveOutReason("node_modules/x/index.js")).toBe("System file");
    expect(skillLeaveOutReason("Node_Modules/x/index.js")).toBeNull();
  });

  it("matches a file name in any case, a folder of that name included", () => {
    expect(skillLeaveOutReason("scripts/OLD.PYC")).toBe("Generated file");
    expect(skillLeaveOutReason("config/.env.local")).toBe(
      "Possible secrets file",
    );
    expect(skillLeaveOutReason("Desktop.INI")).toBe("System file");
    expect(skillLeaveOutReason("node_modules")).toBe("System file");
  });

  it("keeps everything else", () => {
    expect(skillLeaveOutReason("lib/venv.py")).toBeNull();
    expect(skillLeaveOutReason("scripts/run.py")).toBeNull();
    expect(skillLeaveOutReason("environment.md")).toBeNull();
  });
});

describe("SKILL_LEAVE_OUT_RULES", () => {
  // The same names run in TypeScript and in the check's `find`: anything a
  // glob or a shell reads differently would split the two.
  it("holds names both sides read the same way", () => {
    for (const rule of SKILL_LEAVE_OUT_RULES) {
      for (const folder of rule.folders) {
        expect(folder).toMatch(/^[A-Za-z0-9._-]+$/);
      }
      for (const file of rule.files) {
        expect(file).toMatch(/^[A-Za-z0-9._*-]+$/);
      }
    }
  });

  // Skill discovery checks a skill's own folder name against the file
  // rules (skillFolders): one that fit a valid skill name would hide it.
  it("has no file rule a skill name could fit", () => {
    for (const rule of SKILL_LEAVE_OUT_RULES) {
      for (const file of rule.files) {
        expect(file.replaceAll("*", "x")).not.toMatch(SKILL_NAME_PATTERN);
      }
    }
  });
});

describe("skillCheckCommand", () => {
  it("only ever embeds a sha256", () => {
    expect(() => skillCheckCommand("'; rm -rf ~; echo '")).toThrow();
    expect(() => skillCheckCommand("A".repeat(64))).toThrow();
    expect(skillCheckCommand("a".repeat(64))).toContain("a".repeat(64));
  });
});
