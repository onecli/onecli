import { describe, expect, it } from "vitest";
import { gitlabPermissions } from "./gitlab";
import { allGroupTools } from "./types";
import { pathMatches } from "../../lib/path-match";

// Regression test for the whoami gap (issue #570): GET /api/v4/user had no
// tool, so it fell into the connection grant's always-blocked "everything
// else" fallback, breaking every client that validates its token on startup
// (glab, MCP servers, SDK validators). A read tool now covers it; these pin
// that it resolves there and nowhere wider.
const tools = gitlabPermissions.groups.flatMap((group) =>
  allGroupTools(group).map((tool) => ({
    id: tool.id,
    category: group.category,
    methods: tool.methods ?? (tool.method ? [tool.method] : []),
    patterns: [tool.pathPattern, ...(tool.aliasPatterns ?? [])],
  })),
);

const toolsFor = (method: string, path: string): string[] =>
  tools
    .filter(
      (t) =>
        (t.methods.length === 0 || t.methods.includes(method)) &&
        t.patterns.some((p) => pathMatches(path, p)),
    )
    .map((t) => t.id);

describe("GitLab whoami is a read tool", () => {
  it("GET /api/v4/user resolves to get_current_user only", () => {
    expect(toolsFor("GET", "/api/v4/user")).toEqual(["get_current_user"]);
  });

  it("get_current_user lives in the read group", () => {
    expect(tools.find((t) => t.id === "get_current_user")?.category).toBe(
      "read",
    );
  });

  // Exact match: the current-user endpoint must not widen to the user *list*
  // or to user sub-resources, which are separate surfaces.
  it.each([
    "/api/v4/users",
    "/api/v4/user/keys",
    "/api/v4/user/emails",
    "/api/v4/user/status",
  ])("does not match %s", (path) => {
    expect(toolsFor("GET", path)).not.toContain("get_current_user");
  });
});
