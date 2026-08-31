import { describe, expect, it } from "vitest";
import { getAppPermissionDefinition } from "./index";

describe("microsoft-365 permissions", () => {
  const def = getAppPermissionDefinition("microsoft-365");

  it("is registered", () => {
    expect(def).toBeDefined();
    expect(def!.provider).toBe("microsoft-365");
  });

  it("targets graph.microsoft.com exclusively with unique tool ids", () => {
    const tools = def!.groups.flatMap((g) => g.tools);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.hostPattern).toBe("graph.microsoft.com");
    }
    const ids = tools.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("classifies send_mail as write and list_messages as read", () => {
    const read = def!.groups.find((g) => g.category === "read")!;
    const write = def!.groups.find((g) => g.category === "write")!;
    expect(read.tools.some((t) => t.id === "list_messages")).toBe(true);
    expect(write.tools.some((t) => t.id === "send_mail")).toBe(true);
  });
});
