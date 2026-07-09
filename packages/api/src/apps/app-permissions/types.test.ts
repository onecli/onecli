import { describe, expect, it } from "vitest";
import {
  allGroupTools,
  toAppPermissionDefinitionSummary,
  type AppPermissionDefinition,
} from "./types";

const definition: AppPermissionDefinition = {
  provider: "testapp",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description: "Everything read",
        hostPattern: "api.testapp.com",
        pathPattern: "/api/*",
        method: "GET",
      },
      tools: [
        {
          id: "read_one",
          name: "Read one",
          description: "Reads one",
          hostPattern: "api.testapp.com",
          pathPattern: "/api/one",
          aliasPatterns: ["/alias/one"],
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "write_one",
          name: "Write one",
          description: "Writes one",
          hostPattern: "api.testapp.com",
          pathPattern: "/api/one",
          methods: ["POST", "DELETE"],
        },
      ],
    },
  ],
};

describe("toAppPermissionDefinitionSummary", () => {
  it("keeps identity fields and group structure, drops the endpoint mapping", () => {
    const summary = toAppPermissionDefinitionSummary(definition);
    expect(summary).toEqual({
      provider: "testapp",
      groups: [
        {
          category: "read",
          wildcard: {
            id: "read_all",
            name: "All read operations",
            description: "Everything read",
          },
          tools: [
            { id: "read_one", name: "Read one", description: "Reads one" },
          ],
        },
        {
          category: "write",
          tools: [
            { id: "write_one", name: "Write one", description: "Writes one" },
          ],
        },
      ],
    });
    // toEqual already rejects extras; pin the leak keys explicitly too
    // ("method" also catches "methods").
    const json = JSON.stringify(summary);
    for (const leaked of [
      "hostPattern",
      "pathPattern",
      "aliasPatterns",
      "method",
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  it("omits wildcard when the group has none", () => {
    const summary = toAppPermissionDefinitionSummary(definition);
    expect(summary.groups[1]).not.toHaveProperty("wildcard");
  });
});

describe("allGroupTools", () => {
  it("returns wildcard-first over both the full and summary shapes", () => {
    expect(allGroupTools(definition.groups[0]!).map((t) => t.id)).toEqual([
      "read_all",
      "read_one",
    ]);
    const summary = toAppPermissionDefinitionSummary(definition);
    expect(allGroupTools(summary.groups[0]!).map((t) => t.id)).toEqual([
      "read_all",
      "read_one",
    ]);
    expect(allGroupTools(summary.groups[1]!).map((t) => t.id)).toEqual([
      "write_one",
    ]);
  });
});
