import { describe, expect, it } from "vitest";
import { skillsFragment, skillsTools } from "./skills";

/**
 * The loading mechanic is the load-bearing part: the harness's skill tool is
 * disabled and its own prompt lists skills as user slash-commands with no
 * paths, so "read the file yourself" — with the real directory — is the only
 * way a model can act on a skill (observed live: without it, the model
 * grepped the filesystem for the SKILL.md and mostly got blocked).
 *
 * The authoring pins are equally load-bearing in the other direction: this
 * text is the ONLY thing that makes "create a skill" land in the platform
 * (durable, dashboard-visible) rather than as loose files a boot purge
 * destroys.
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

  it("teaches create-via-platform as the default, files only on explicit ask", () => {
    const flat = skillsFragment(".agents/skills").body.replace(/\s+/g, " ");
    expect(flat).toContain("To create one, use skill_create");
    expect(flat).toContain("Never write a skill as loose files");
    expect(flat).toContain(
      "unless the person explicitly asks for a file at some other location",
    );
  });

  it("names all four tools and the tier boundary", () => {
    const flat = skillsFragment(".agents/skills").body.replace(/\s+/g, " ");
    for (const tool of [
      "skill_create",
      "skill_update",
      "skill_delete",
      "skill_list",
    ]) {
      expect(flat).toContain(tool);
    }
    expect(flat).toContain(
      "Workspace and organization skills are managed by the people you work with in the dashboard",
    );
  });
});

describe("the skills tools", () => {
  const byName = new Map(skillsTools.map((tool) => [tool.name, tool]));

  it("ships exactly the four agent-tier tools", () => {
    expect([...byName.keys()].sort()).toEqual([
      "skill_create",
      "skill_delete",
      "skill_list",
      "skill_update",
    ]);
  });

  it("skill_create pins the control plane's bounds (kept identical by eye)", () => {
    const schema = byName.get("skill_create")?.inputSchema as {
      properties: Record<
        string,
        { pattern?: string; maxLength?: number; description?: string }
      >;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["name", "description", "content"]);
    expect(schema.additionalProperties).toBe(false);
    // validations/skills.ts: SKILL_NAME_PATTERN / SKILL_NAME_MAX_LENGTH /
    // SKILL_DESCRIPTION_MAX_LENGTH / SKILL_CONTENT_MAX_LENGTH.
    expect(schema.properties.name?.pattern).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$");
    expect(schema.properties.name?.maxLength).toBe(64);
    expect(schema.properties.description?.maxLength).toBe(500);
    expect(schema.properties.content?.maxLength).toBe(24_000);
  });

  it("steers away from loose files and toward the durable platform set", () => {
    const description = byName.get("skill_create")?.description ?? "";
    expect(description).toContain("never loose files");
    expect(description).toContain("materializes into your skills directory");
  });

  it("update/delete say whose rows they touch and where the rest is managed", () => {
    expect(byName.get("skill_update")?.description).toContain(
      "your own agent skills",
    );
    expect(byName.get("skill_update")?.description).toContain("dashboard");
    expect(byName.get("skill_delete")?.description).toContain(
      "your own agent skills",
    );
    // The softer alternative is taught: pause over destroy.
    expect(byName.get("skill_delete")?.description).toContain("enabled=false");
  });
});
