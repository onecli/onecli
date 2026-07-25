import { describe, expect, it } from "vitest";
import {
  allGroupTools,
  toAppPermissionDefinitionSummary,
  wildcardCoversGroup,
  type AppPermissionDefinition,
  type AppTool,
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
          // The read_one alias "/alias/one" escapes the "/api/*" wildcard, so
          // the umbrella is NOT a true superset of the group — the picker won't
          // offer it (see wildcardCoversGroup).
          wildcardComplete: false,
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

describe("wildcardCoversGroup", () => {
  const wildcard: AppTool = {
    id: "read_all",
    name: "All read operations",
    description: "Everything read",
    hostPattern: "api.testapp.com",
    pathPattern: "/api/v2/*",
    method: "GET",
  };
  const covered: AppTool = {
    id: "read_one",
    name: "Read one",
    description: "",
    hostPattern: "api.testapp.com",
    pathPattern: "/api/v2/things/*",
    method: "GET",
  };

  it("is true when every tool shares the host, a path prefix, and a method subset", () => {
    expect(wildcardCoversGroup(wildcard, [covered])).toBe(true);
    expect(wildcardCoversGroup(wildcard, [])).toBe(true);
  });

  it("is false when a tool uses a method the wildcard lacks (the Jira POST-search shape)", () => {
    const postSearch: AppTool = {
      ...covered,
      id: "search",
      pathPattern: "/api/v2/search",
      methods: ["GET", "POST"],
    };
    expect(wildcardCoversGroup(wildcard, [covered, postSearch])).toBe(false);
  });

  it("is false when a tool's path escapes the prefix (the Confluence /rest/ shape)", () => {
    const otherPath: AppTool = {
      ...covered,
      id: "search",
      pathPattern: "/rest/api/search",
    };
    expect(wildcardCoversGroup(wildcard, [covered, otherPath])).toBe(false);
  });

  it("is false when a tool's alias escapes the prefix", () => {
    const aliased: AppTool = { ...covered, aliasPatterns: ["/legacy/things"] };
    expect(wildcardCoversGroup(wildcard, [aliased])).toBe(false);
  });

  it("is false when a tool is on a different host", () => {
    const otherHost: AppTool = { ...covered, hostPattern: "cdn.testapp.com" };
    expect(wildcardCoversGroup(wildcard, [otherHost])).toBe(false);
  });
});
