import { describe, expect, it } from "vitest";
import { bitbucket } from "../bitbucket";
import { bitbucketPermissions } from "./bitbucket";
import { allGroupTools, hostPatternsOf, methodsOf } from "./types";
import { hostMatches, pathMatches } from "../../lib/path-match";
import {
  compileConnectionStack,
  defaultConnectionGrant,
} from "../../services/grants-compile";
import { evaluateNew } from "../../services/policy-translation/evaluator";
import type { NewRule } from "../../services/policy-translation/types";

// Pins the Bitbucket catalog to the Bitbucket Cloud REST API 2.0 reference
// (developer.atlassian.com/cloud/bitbucket/rest, its OpenAPI document) and
// to git's smart-HTTP transport. A tool is what an allow/deny grant binds to,
// so every documented endpoint the catalog claims lands on exactly the tool
// whose name describes it, and the endpoints that hold a secret land on none
// (they stay on Needs approval: `catalog-unlisted-reads.test.ts`).

const tools = bitbucketPermissions.groups.flatMap((group) =>
  allGroupTools(group).map((tool) => ({
    id: tool.id,
    category: group.category,
    hosts: hostPatternsOf(tool),
    methods: methodsOf(tool),
    patterns: [tool.pathPattern, ...(tool.aliasPatterns ?? [])],
  })),
);

const API = "api.bitbucket.org";
const GIT = "bitbucket.org";
const R = "/2.0/repositories/acme/web";

const matchingTools = (host: string, method: string, path: string): string[] =>
  tools
    .filter(
      (tool) =>
        tool.hosts.some((pattern) => hostMatches(host, pattern)) &&
        tool.methods.includes(method) &&
        tool.patterns.some((pattern) => pathMatches(path, pattern)),
    )
    .map((tool) => tool.id);

describe("every documented endpoint resolves to its tool", () => {
  it.each([
    // git smart HTTP
    [GIT, "POST", "/acme/web.git/git-upload-pack", "git_clone"],
    [GIT, "POST", "/acme/web.git/git-receive-pack", "git_push"],
    // Users and workspaces
    [API, "GET", "/2.0/user", "get_user"],
    [API, "GET", "/2.0/user/workspaces", "list_workspaces"],
    // Repositories and their content
    [API, "GET", "/2.0/repositories/acme", "list_repositories"],
    [API, "GET", "/2.0/repositories/acme/", "list_repositories"],
    [API, "GET", R, "get_repository"],
    [API, "GET", `${R}/`, "get_repository"],
    [API, "GET", `${R}/src`, "get_repository"],
    [API, "GET", `${R}/src/main/README.md`, "get_repository"],
    [API, "GET", `${R}/commits`, "get_repository"],
    [API, "GET", `${R}/commits/main`, "get_repository"],
    [API, "GET", `${R}/commit/abc123`, "get_repository"],
    [API, "GET", `${R}/refs`, "get_repository"],
    [API, "GET", `${R}/refs/branches`, "get_repository"],
    [API, "GET", `${R}/refs/branches/main`, "get_repository"],
    [API, "GET", `${R}/refs/tags/v1`, "get_repository"],
    [API, "GET", `${R}/diff/main..feat`, "get_repository"],
    [API, "GET", `${R}/diffstat/main..feat`, "get_repository"],
    // Pull requests
    [API, "GET", `${R}/pullrequests`, "list_pull_requests"],
    [API, "GET", `${R}/pullrequests/7`, "get_pull_request"],
    [API, "GET", `${R}/pullrequests/7/diff`, "get_pull_request"],
    [API, "GET", `${R}/pullrequests/7/comments`, "get_pull_request"],
    [API, "POST", `${R}/pullrequests`, "create_pull_request"],
    [API, "POST", `${R}/pullrequests/`, "create_pull_request"],
    [API, "PUT", `${R}/pullrequests/7`, "update_pull_request"],
    [API, "POST", `${R}/pullrequests/7/comments`, "comment_pull_request"],
    [API, "POST", `${R}/pullrequests/7/approve`, "approve_pull_request"],
    [API, "DELETE", `${R}/pullrequests/7/approve`, "approve_pull_request"],
    [API, "POST", `${R}/pullrequests/7/merge`, "merge_pull_request"],
    [API, "POST", `${R}/pullrequests/7/decline`, "decline_pull_request"],
    // Branches
    [API, "POST", `${R}/refs/branches`, "create_branch"],
    [API, "DELETE", `${R}/refs/branches/feat`, "delete_branch"],
    // Pipelines runs
    [API, "GET", `${R}/pipelines`, "list_pipelines"],
    [API, "GET", `${R}/pipelines/%7Bp1%7D`, "list_pipelines"],
    [
      API,
      "GET",
      `${R}/pipelines/%7Bp1%7D/steps/%7Bs1%7D/log`,
      "list_pipelines",
    ],
  ])("%s %s %s -> %s", (host, method, path, expected) => {
    expect(matchingTools(host, method, path)).toEqual([expected]);
  });
});

describe("no tool reaches what it does not name", () => {
  it.each([
    // Secrets live beside the repository: variables, deploy keys, webhooks.
    [API, "GET", `${R}/pipelines_config/variables`],
    [API, "GET", `${R}/deployments_config/environments/%7Be1%7D/variables`],
    [API, "GET", `${R}/deploy-keys`],
    [API, "GET", `${R}/hooks`],
    [API, "GET", "/2.0/workspaces/acme/pipelines-config/variables"],
    // A pull request comment edit is not a pull request edit.
    [API, "PUT", `${R}/pullrequests/7/comments/9`],
    // Repository create/delete need admin/delete scopes OneCLI never asks for.
    [API, "POST", R],
    [API, "DELETE", R],
    // Removed by Bitbucket: the cross-workspace list and the issue tracker.
    [API, "GET", "/2.0/workspaces"],
    [API, "GET", `${R}/issues`],
    // git's own paths answer only on bitbucket.org, the API only on its host.
    [API, "POST", "/acme/web.git/git-upload-pack"],
    [GIT, "GET", "/2.0/user"],
    ["evilbitbucket.org", "POST", "/acme/web.git/git-receive-pack"],
  ])("%s %s %s matches no tool", (host, method, path) => {
    expect(matchingTools(host, method, path)).toEqual([]);
  });
});

describe("a new connection's default grant", () => {
  const stack: NewRule[] = compileConnectionStack(
    "Grant: a · c",
    "bitbucket",
    defaultConnectionGrant("bitbucket"),
  ).map((rule, i) => ({
    scope: "workspace",
    priority: i,
    isDefault: false,
    source: "grant",
    name: rule.name,
    identities: [{ type: "agent", id: "agent-1" }],
    targets: [
      {
        kind: "connection",
        connectionId: "conn-1",
        provider: "bitbucket",
        tools: rule.tools,
        method: rule.method ?? null,
      },
    ],
    action: rule.action,
    requireApproval: rule.requireApproval,
    rateLimit: null,
    rateLimitWindow: null,
    conditions: null,
  }));
  const decide = (host: string, method: string, path: string) =>
    evaluateNew(stack, {
      host,
      path,
      method,
      agentId: "agent-1",
      hasInjections: true,
      isLlmHost: false,
      winningConnectionId: "conn-1",
    });

  it.each([
    [GIT, "GET", "/acme/web.git/info/refs?service=git-upload-pack"],
    [GIT, "POST", "/acme/web.git/git-upload-pack"],
    [API, "GET", `${R}/pipelines`],
    [API, "GET", "/2.0/user/workspaces"],
  ])("lets a read run: %s %s %s", (host, method, path) => {
    expect(decide(host, method, path)).toEqual({ action: "allow" });
  });

  it.each([
    [GIT, "GET", "/acme/web.git/info/refs?service=git-receive-pack"],
    [GIT, "POST", "/acme/web.git/git-receive-pack"],
    [API, "POST", `${R}/pullrequests`],
    [API, "POST", `${R}/pullrequests/7/merge`],
  ])("holds a write for approval: %s %s %s", (host, method, path) => {
    expect(decide(host, method, path)).toEqual({
      action: "allow",
      requireApproval: true,
    });
  });
});

describe("categories follow what a request does", () => {
  it("every read tool is GET or a git fetch, every write tool changes state", () => {
    for (const tool of tools) {
      const reads = tool.methods.every(
        (m) => m === "GET" || tool.id === "git_clone",
      );
      expect(reads, tool.id).toBe(tool.category === "read");
    }
  });
});

describe("requested scopes", () => {
  it("names only scopes Bitbucket still offers (no issue tracker)", () => {
    const method = bitbucket.connectionMethod;
    if (method.type !== "oauth") throw new Error("bitbucket must be oauth");
    const scopes = [
      ...(method.defaultScopes ?? []),
      ...(method.permissions ?? []).map((p) => p.scope),
    ];
    expect(scopes.filter((s) => s.startsWith("issue"))).toEqual([]);
  });
});
