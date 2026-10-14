import { describe, expect, it } from "vitest";

import { createMemorySchema, memorySaveArgsSchema } from "./memories";

// `memory/index.md` is the generated memory index that buildHomeFileSet
// projects next to every `memory/<key>.md`. A memory keyed `index` would be
// projected to the SAME path and overwritten by the index (which the
// supervisor also never harvests as a memory), so both doors must refuse it.
describe("memory key validation", () => {
  it("refuses the reserved key `index` from the dashboard door", () => {
    const result = createMemorySchema.safeParse({
      key: "index",
      content: "the real content",
    });
    expect(result.success).toBe(false);
  });

  it("refuses the reserved key `index` from the memory_save tool door", () => {
    const result = memorySaveArgsSchema.safeParse({
      key: " index ",
      content: "the real content",
    });
    expect(result.success).toBe(false);
  });

  it("still accepts ordinary keys, including ones that contain `index`", () => {
    for (const key of ["deploy-notes", "index-notes", "project-index"]) {
      expect(createMemorySchema.safeParse({ key, content: "x" }).success).toBe(
        true,
      );
      expect(
        memorySaveArgsSchema.safeParse({ key, content: "x" }).success,
      ).toBe(true);
    }
  });
});
