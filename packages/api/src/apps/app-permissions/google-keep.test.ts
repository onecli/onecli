import { describe, expect, it } from "vitest";
import { googleKeepPermissions } from "./google-keep";
import { allGroupTools, methodsOf } from "./types";
import { pathMatches } from "../../lib/path-match";

// Pins the Keep catalog to the v1 discovery document
// (https://keep.googleapis.com/$discovery/rest?version=v1). A tool is what an
// allow/deny grant binds to, so each documented method must land on exactly
// the tool whose name describes it, and nothing else.

const tools = googleKeepPermissions.groups.flatMap((group) =>
  allGroupTools(group).map((tool) => ({
    id: tool.id,
    methods: methodsOf(tool),
    patterns: [tool.pathPattern, ...(tool.aliasPatterns ?? [])],
  })),
);

const matchingTools = (method: string, path: string): string[] =>
  tools
    .filter(
      (tool) =>
        tool.methods.includes(method) &&
        tool.patterns.some((pattern) => pathMatches(path, pattern)),
    )
    .map((tool) => tool.id);

describe("every documented Keep method resolves to exactly its tool", () => {
  it.each([
    ["GET", "/v1/notes", "list_notes"],
    ["GET", "/v1/notes?filter=trashed%3Dfalse&pageSize=50", "list_notes"],
    ["GET", "/v1/notes/n1", "get_note"],
    ["POST", "/v1/notes", "create_note"],
    ["DELETE", "/v1/notes/n1", "delete_note"],
    ["GET", "/v1/notes/n1/attachments/a1", "download_attachment"],
    [
      "GET",
      "/v1/notes/n1/attachments/a1?alt=media&mimeType=image%2Fpng",
      "download_attachment",
    ],
    [
      "GET",
      "/download/v1/notes/n1/attachments/a1?alt=media",
      "download_attachment",
    ],
    ["POST", "/v1/notes/n1/permissions:batchCreate", "share_note"],
    ["POST", "/v1/notes/n1/permissions:batchDelete", "unshare_note"],
  ])("%s %s -> %s", (method, path, expected) => {
    expect(matchingTools(method, path)).toEqual([expected]);
  });
});

describe("note-level tools never reach a note's sub-resources", () => {
  // `get_note` and `delete_note` pin their depth with a trailing slash; a
  // terminal `*` would also swallow attachments and permissions.
  it.each([
    ["GET", "/v1/notes/n1/attachments/a1", "get_note"],
    ["DELETE", "/v1/notes/n1/attachments/a1", "delete_note"],
    ["DELETE", "/v1/notes/n1/permissions:batchDelete", "delete_note"],
  ])("%s %s is not %s", (method, path, tool) => {
    expect(matchingTools(method, path)).not.toContain(tool);
  });
});

describe("requests the API does not serve match no tool", () => {
  // Keep has no update method and no other permission verbs, so none of these
  // may borrow a tool's grant; they fall to the catalog's approval terminal.
  it.each([
    ["PATCH", "/v1/notes/n1"],
    ["PUT", "/v1/notes/n1"],
    ["POST", "/v1/notes/n1/permissions:batchUpdate"],
    ["POST", "/v1/notes/n1/attachments/a1"],
    ["GET", "/v1/notes/n1/permissions"],
  ])("no tool matches %s %s", (method, path) => {
    expect(matchingTools(method, path)).toEqual([]);
  });
});
