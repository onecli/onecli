import { describe, expect, it } from "vitest";
import { cronsTools } from "./crons";
import { memoryFragment, memoryTools } from "./memory";

/**
 * The model-facing memory contract. The bounds here are kept identical to
 * the control plane's zod (validations/memories.ts) BY EYE — these literals
 * are the supervisor half of that pact, so a drift edits this file and the
 * reviewer sees both sides move.
 */

const toolByName = (name: string) =>
  memoryTools.find((tool) => tool.name === name);

describe("the memory tool surface", () => {
  it("declares exactly the four tools", () => {
    expect(memoryTools.map((tool) => tool.name)).toEqual([
      "memory_save",
      "memory_list",
      "memory_search",
      "memory_get",
    ]);
  });

  it("never collides with another capability's names", () => {
    const cronNames = new Set(cronsTools.map((tool) => tool.name));
    for (const tool of memoryTools) {
      expect(cronNames.has(tool.name)).toBe(false);
    }
  });

  it("every schema is closed and its required keys exist", () => {
    for (const tool of memoryTools) {
      const schema = tool.inputSchema as {
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.additionalProperties).toBe(false);
      for (const key of schema.required ?? []) {
        expect(schema.properties, `${tool.name}.${key}`).toHaveProperty(key);
      }
    }
  });

  it("mirrors the control plane's bounds by eye", () => {
    const save = toolByName("memory_save")?.inputSchema as {
      properties: Record<string, { maxLength?: number; pattern?: string }>;
    };
    expect(save.properties.key?.maxLength).toBe(80);
    expect(save.properties.key?.pattern).toBe("^[a-z0-9]+(?:-[a-z0-9]+)*$");
    expect(save.properties.content?.maxLength).toBe(12_000);
    expect(save.properties.description?.maxLength).toBe(300);
    expect(save.properties.title?.maxLength).toBe(120);

    const search = toolByName("memory_search")?.inputSchema as {
      properties: Record<string, { maxLength?: number }>;
    };
    expect(search.properties.query?.maxLength).toBe(500);

    const get = toolByName("memory_get")?.inputSchema as {
      properties: Record<string, { maxLength?: number }>;
    };
    expect(get.properties.key?.maxLength).toBe(80);
  });

  it("the fragment teaches the four tools and the no-secrets law", () => {
    expect(memoryFragment.title).toBe("Memory");
    for (const name of [
      "memory_save",
      "memory_search",
      "memory_list",
      "memory_get",
    ]) {
      expect(memoryFragment.body).toContain(name);
    }
    expect(memoryFragment.body).toContain("Never store secrets");
  });

  it("the fragment teaches the write-back laws (files writable, index generated, deletes restored)", () => {
    // The laws the write-back amendment added — each one steers real agent
    // behavior the platform depends on.
    expect(memoryFragment.body).toContain("edit or create memory/");
    expect(memoryFragment.body).toContain(
      "memory/index.md is generated — never edit it",
    );
    expect(memoryFragment.body).toContain(
      "Deleting a file does not delete the memory",
    );
    expect(memoryFragment.body).toContain("source of truth");
  });
});
