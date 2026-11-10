import { describe, expect, it } from "vitest";
import {
  SKILL_CONTENT_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_TOOL_TEXT_MAX_LENGTH,
  cleanSkillDescription,
  createOrgSkillSchema,
  createSkillSchema,
  skillCreateArgsSchema,
  skillUpdateArgsSchema,
  updateSkillSchema,
} from "./skills";

// Built from char codes, so no literal control byte sits in this source.
const BEL = String.fromCharCode(0x07);
const TAB = String.fromCharCode(0x09);
const CR = String.fromCharCode(0x0d);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x85);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);

describe("cleanSkillDescription", () => {
  it("drops control and invisible format characters", () => {
    expect(
      cleanSkillDescription(
        `Use${BEL} it${DEL} for${C1} rel${ZWSP}eases${RLO}${BOM}.`,
      ),
    ).toBe("Use it for releases.");
  });

  it("keeps words apart where a tab or carriage return sat between them", () => {
    expect(cleanSkillDescription(`one${TAB}two${CR}three  four`)).toBe(
      "one two three four",
    );
  });

  it("keeps printable text as written, quotes and emoji included", () => {
    const text = 'Use when: "deploying" to prod 🚀, or rolling back';
    expect(cleanSkillDescription(text)).toBe(text);
  });

  it("clamps without splitting an emoji", () => {
    expect(cleanSkillDescription("ab🚀", 3)).toBe("ab");
  });

  it("drops Unicode tag characters and lone surrogates, keeps real pairs", () => {
    // Tag characters spell invisible ASCII a model still reads.
    const tags = String.fromCodePoint(0xe0041, 0xe0042, 0xe007f);
    const lone = String.fromCharCode(0xd800);
    const trailing = String.fromCharCode(0xdc00);
    expect(
      cleanSkillDescription(`Use${tags} it${lone} for${trailing} 🚀 notes`),
    ).toBe("Use it for 🚀 notes");
  });

  it("leaves nothing that JSON escapes to more than 2 characters", () => {
    const hostile = Array.from({ length: 0xa0 }, (_, code) =>
      String.fromCharCode(code),
    ).join("");
    const cleaned = cleanSkillDescription(hostile.repeat(4));
    expect(JSON.stringify(cleaned)).not.toMatch(/\\u00/);
  });
});

describe("every door stores a clean description", () => {
  const base = { name: "release-notes", content: "body" };
  const dirty = `Use${BEL} it${RLO} for${TAB}releases`;

  it.each([
    ["the dashboard and API create", createSkillSchema, { agentId: "ag-1" }],
    ["the org create", createOrgSkillSchema, {}],
    ["the agent's skill_create", skillCreateArgsSchema, {}],
  ] as const)("%s", (_door, schema, extra) => {
    const parsed = schema.parse({ ...base, ...extra, description: dirty });
    expect(parsed.description).toBe("Use it for releases");
  });

  it.each([
    ["the dashboard and API patch", updateSkillSchema, {}],
    ["the agent's skill_update", skillUpdateArgsSchema, { name: "a-skill" }],
  ] as const)("%s", (_door, schema, extra) => {
    const parsed = schema.parse({ ...extra, description: dirty });
    expect(parsed.description).toBe("Use it for releases");
  });

  it("still refuses a newline with its own message", () => {
    const result = createOrgSkillSchema.safeParse({
      ...base,
      description: "line one\nline two",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/single line/);
  });

  it("refuses a description with nothing printable in it", () => {
    const result = createOrgSkillSchema.safeParse({
      ...base,
      description: `${BEL}${RLO}${ZWSP}`,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Description is required");
  });

  it("still counts the limit on what was sent", () => {
    const result = createOrgSkillSchema.safeParse({
      ...base,
      description: "d".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });
});

describe("one body limit, and a tool door that fits its pipe", () => {
  const at = "x".repeat(SKILL_CONTENT_MAX_LENGTH);
  const over = `${at}x`;

  it("the dashboard doors take a body up to 120,000, however it arrived", () => {
    expect(SKILL_CONTENT_MAX_LENGTH).toBe(120_000);
    expect(updateSkillSchema.safeParse({ content: at }).success).toBe(true);
    expect(updateSkillSchema.safeParse({ content: over }).success).toBe(false);
    const create = { name: "n", description: "d", content: at, agentId: "a" };
    expect(createSkillSchema.safeParse(create).success).toBe(true);
    expect(
      createSkillSchema.safeParse({ ...create, content: over }).success,
    ).toBe(false);
  });

  it("no longer caps body + files together", () => {
    const result = createSkillSchema.safeParse({
      name: "n",
      description: "d",
      agentId: "a",
      content: "x".repeat(40_000),
      files: [{ path: "a.md", content: "y".repeat(20_000) }],
    });
    expect(result.success).toBe(true);
  });

  it("a whole body over the tool door's own limit is refused", () => {
    // The tool-args pipe (32k) can't carry the 120,000 body limit whole, so
    // skill_create and a whole skill_update hold their body to the tool
    // door's limit; a longer skill changes in place (edits / append).
    const whole = "x".repeat(SKILL_TOOL_TEXT_MAX_LENGTH + 1);
    expect(
      skillUpdateArgsSchema.safeParse({ name: "n", content: whole }).success,
    ).toBe(false);
    expect(
      skillCreateArgsSchema.safeParse({
        name: "n",
        description: "d",
        content: whole,
      }).success,
    ).toBe(false);
    // Plain Markdown at that limit fits the pipe JSON-encoded.
    const markdown = "- step\n".repeat(SKILL_TOOL_TEXT_MAX_LENGTH / 7);
    expect(
      JSON.stringify({ name: "n", content: markdown }).length,
    ).toBeLessThan(32_000);
  });

  it("skill_update edits in place: edits and append, never with content", () => {
    expect(
      skillUpdateArgsSchema.safeParse({
        name: "n",
        edits: [{ find: "a", replace: "" }],
        append: "more",
      }).success,
    ).toBe(true);
    expect(
      skillUpdateArgsSchema.safeParse({
        name: "n",
        content: "all",
        append: "more",
      }).success,
    ).toBe(false);
    expect(
      skillUpdateArgsSchema.safeParse({ name: "n", edits: [] }).success,
    ).toBe(false);
    expect(
      skillUpdateArgsSchema.safeParse({
        name: "n",
        edits: [{ find: "", replace: "x" }],
      }).success,
    ).toBe(false);
  });
});
