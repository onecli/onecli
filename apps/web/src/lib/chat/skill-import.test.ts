import { describe, expect, it } from "vitest";
import { isSkillImportTool, parseSkillImport } from "./skill-import";

const result = {
  imported: [
    {
      name: "incident-tools",
      files: 22,
      bytes: 987_000,
      groups: { fixtures: 9, playbooks: 7, references: 3, tools: 2 },
      skipped: [{ path: ".DS_Store", reason: "System file" }],
      skippedCount: 1,
      replaced: false,
    },
  ],
  problems: [{ folder: "Bad Name", reason: "Not a valid name" }],
  problemCount: 3,
  note: "ignored",
};

describe("parseSkillImport", () => {
  it("reads what the import did", () => {
    expect(parseSkillImport(JSON.stringify(result))).toEqual({
      skills: [
        {
          name: "incident-tools",
          files: 22,
          bytes: 987_000,
          groups: { fixtures: 9, playbooks: 7, references: 3, tools: 2 },
          skipped: [{ path: ".DS_Store", reason: "System file" }],
          skippedCount: 1,
          replaced: false,
        },
      ],
      problems: [{ folder: "Bad Name", reason: "Not a valid name" }],
      problemCount: 3,
    });
  });

  it("never counts fewer problems than it lists", () => {
    const parsed = parseSkillImport(
      JSON.stringify({ ...result, problemCount: "many" }),
    );
    expect(parsed?.problemCount).toBe(1);
  });

  it("shows no card for an error or anything unexpected", () => {
    expect(parseSkillImport(undefined)).toBeNull();
    expect(parseSkillImport("No file the person sent you is at x")).toBeNull();
    expect(parseSkillImport(JSON.stringify({ imported: "nope" }))).toBeNull();
    expect(
      parseSkillImport(JSON.stringify({ imported: [], problems: [] })),
    ).toBeNull();
  });

  it("drops malformed entries instead of rendering them", () => {
    const parsed = parseSkillImport(
      JSON.stringify({
        imported: [{ files: 3 }, { name: "ok", files: -4, groups: { x: "9" } }],
      }),
    );
    expect(parsed?.skills).toEqual([
      {
        name: "ok",
        files: 0,
        bytes: 0,
        groups: {},
        skipped: [],
        skippedCount: 0,
        replaced: false,
      },
    ]);
  });

  it("keeps folders named like Object members as plain counts", () => {
    const parsed = parseSkillImport(
      '{"imported":[{"name":"s","groups":{"__proto__":3,"constructor":2}}]}',
    );
    const groups = parsed?.skills[0]?.groups ?? {};
    expect(Object.entries(groups)).toEqual([
      ["__proto__", 3],
      ["constructor", 2],
    ]);
    expect(Object.getPrototypeOf(groups)).toBe(Object.prototype);
  });
});

describe("isSkillImportTool", () => {
  it("matches the tool bare or MCP-prefixed, nothing else", () => {
    expect(isSkillImportTool("skill_import")).toBe(true);
    expect(isSkillImportTool("mcp__onecli__skill_import")).toBe(true);
    expect(isSkillImportTool("skill_create")).toBe(false);
  });
});
