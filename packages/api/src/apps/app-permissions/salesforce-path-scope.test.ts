import { describe, expect, it } from "vitest";
import { salesforcePermissions } from "./salesforce";
import { allGroupTools } from "./types";
import { pathMatches } from "../../lib/path-match";

// This file exists because of a real bug caught in review: `pathMatches` treats
// a pattern whose ONLY `*` is its last character as a RAW PREFIX, so the
// innocent-looking `/services/data/v*` silently matched
// `/services/data/v66.0/graphql`, `/composite` and `/jobs/query`. Those are
// exactly the surfaces this catalog refuses to describe, so a read tool was
// granting them.
//
// The catalog is not itself a policy (the default is ALLOW), but these tool
// patterns are what an explicit allow/deny binds to — so a tool that reaches
// further than its name claims makes a user's grant a lie. Pin the boundary.

const tools = salesforcePermissions.groups.flatMap((group) =>
  allGroupTools(group).map((tool) => ({
    id: tool.id,
    methods: tool.methods ?? (tool.method ? [tool.method] : []),
    patterns: [tool.pathPattern, ...(tool.aliasPatterns ?? [])],
  })),
);

const matchingTools = (path: string): string[] =>
  tools
    .filter((tool) => tool.patterns.some((p) => pathMatches(path, p)))
    .map((tool) => tool.id);

describe("unsupported API surfaces stay outside every tool", () => {
  // Each of these can express arbitrary multi-object work (or bypass the
  // per-tool method split), which no tool here claims to cover.
  it.each([
    "/services/data/v66.0/composite",
    "/services/data/v66.0/composite/batch",
    "/services/data/v66.0/composite/tree/Account",
    "/services/data/v66.0/composite/sobjects",
    "/services/data/v66.0/jobs/query",
    "/services/data/v66.0/jobs/ingest",
    "/services/data/v66.0/graphql",
    "/services/data/v66.0/tooling/query",
    "/services/data/v66.0/actions/custom/apex",
    "/services/apexrest/custom",
  ])("no tool matches %s", (path) => {
    expect(matchingTools(path)).toEqual([]);
  });
});

describe("each tool matches its own endpoint", () => {
  it.each([
    ["list_versions", "/services/data"],
    ["list_versions", "/services/data/"],
    ["list_resources", "/services/data/v66.0/"],
    ["list_objects", "/services/data/v66.0/sobjects"],
    ["list_objects", "/services/data/v66.0/sobjects/"],
    ["describe_object", "/services/data/v66.0/sobjects/Account/describe"],
    ["get_record", "/services/data/v66.0/sobjects/Account/001000000000001"],
    // Salesforce exposes a single field of a record at a deeper path; the
    // record-level pattern covers it because the trailing `*` takes 1+ segments.
    [
      "get_record",
      "/services/data/v66.0/sobjects/Account/001000000000001/Name",
    ],
    ["query", "/services/data/v66.0/query"],
    ["query", "/services/data/v66.0/query?q=SELECT+Id+FROM+Account"],
    ["query_more", "/services/data/v66.0/query/01g000000000000-2000"],
    ["query_all", "/services/data/v66.0/queryAll"],
    ["query_all_more", "/services/data/v66.0/queryAll/01g000000000000-2000"],
    ["search", "/services/data/v66.0/search"],
    ["create_record", "/services/data/v66.0/sobjects/Account/"],
    // The slashless spelling Salesforce also accepts (prod, 2026-09-29: an
    // agent's every create went here and died on the grant's catch-all).
    ["create_record", "/services/data/v59.0/sobjects/Contact"],
    ["update_record", "/services/data/v66.0/sobjects/Account/001000000000001"],
  ])("%s matches %s", (id, path) => {
    expect(matchingTools(path)).toContain(id);
  });
});

describe("the read/write split holds", () => {
  const readIds = new Set(
    salesforcePermissions.groups
      .filter((g) => g.category === "read")
      .flatMap((g) => allGroupTools(g).map((t) => t.id)),
  );

  it("every read tool is GET-only", () => {
    for (const tool of tools.filter((t) => readIds.has(t.id))) {
      expect(tool.methods).toEqual(["GET"]);
    }
  });

  it("no tool is authored without a method", () => {
    // An empty method list reads as "any method" in the gateway catalog —
    // fail-open. Every Salesforce tool must name its method.
    for (const tool of tools) expect(tool.methods.length).toBeGreaterThan(0);
  });

  it("a create grant does not reach an existing record's path", () => {
    // POST to a record path with a `_HttpMethod` override is how a create-only
    // grant would otherwise be turned into an update or a delete.
    const create = tools.find((t) => t.id === "create_record");
    for (const path of [
      "/services/data/v66.0/sobjects/Account/001000000000001",
      "/services/data/v66.0/sobjects/Account/001000000000001/",
      "/services/data/v66.0/sobjects",
      "/services/data/v66.0/sobjects/",
    ]) {
      expect(
        create?.patterns.some((p) => pathMatches(path, p)),
        path,
      ).toBe(false);
    }
  });
});
