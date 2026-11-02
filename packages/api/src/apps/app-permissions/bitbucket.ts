import type { AppPermissionDefinition } from "./types";

/**
 * Bitbucket Cloud: the REST API 2.0 on api.bitbucket.org, where repository
 * paths are `/2.0/repositories/{workspace}/{repo_slug}/...`, and git over
 * HTTPS on bitbucket.org. Read tools stay at their own depth (a trailing
 * slash = exactly one segment, with or without the slash): a raw
 * `/repositories/*` prefix would also reach a repository's Pipelines and
 * deployment variables, deploy keys and webhooks, which stay outside every
 * tool and so need approval (`catalog-unlisted-reads.test.ts`).
 *
 * Bitbucket removed its issue tracker and wiki APIs on 20 August 2026, so
 * neither is listed.
 */
export const bitbucketPermissions: AppPermissionDefinition = {
  provider: "bitbucket",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "git_clone",
          name: "Git clone / pull",
          description: "Clone or pull repository contents via git over HTTPS",
          hostPattern: "bitbucket.org",
          pathPattern: "/*/*/git-upload-pack",
          method: "POST",
        },
        {
          id: "get_user",
          name: "Read profile",
          description: "Get the authenticated user's profile",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/user",
          method: "GET",
        },
        {
          id: "list_workspaces",
          name: "List workspaces",
          description: "List the workspaces the user belongs to",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/user/workspaces",
          method: "GET",
        },
        {
          id: "list_repositories",
          name: "List repositories",
          description: "List repositories in a workspace",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/",
          method: "GET",
        },
        {
          id: "get_repository",
          name: "Read repository",
          description:
            "Get repository details, files, commits, branches, tags, and diffs",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/",
          aliasPatterns: [
            "/2.0/repositories/*/*/src/",
            "/2.0/repositories/*/*/src/*",
            "/2.0/repositories/*/*/commits/",
            "/2.0/repositories/*/*/commits/*",
            "/2.0/repositories/*/*/commit/*",
            "/2.0/repositories/*/*/refs/",
            "/2.0/repositories/*/*/refs/*",
            "/2.0/repositories/*/*/diff/*",
            "/2.0/repositories/*/*/diffstat/*",
          ],
          method: "GET",
        },
        {
          id: "list_pull_requests",
          name: "List pull requests",
          description: "List pull requests in a repository",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/pullrequests/",
          method: "GET",
        },
        {
          id: "get_pull_request",
          name: "Get pull request",
          description: "Get a pull request, its diff, commits, and comments",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/pullrequests/*",
          method: "GET",
        },
        {
          id: "list_pipelines",
          name: "List Pipelines runs",
          description: "View Pipelines runs, their steps, and step logs",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/pipelines/",
          aliasPatterns: ["/2.0/repositories/*/*/pipelines/*"],
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "git_push",
          name: "Git push",
          description: "Push commits to a repository via git over HTTPS",
          hostPattern: "bitbucket.org",
          pathPattern: "/*/*/git-receive-pack",
          method: "POST",
        },
        {
          id: "create_pull_request",
          name: "Create pull request",
          description: "Open a new pull request",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/pullrequests/",
          method: "POST",
        },
        {
          id: "update_pull_request",
          name: "Update pull request",
          description: "Edit a pull request's title, description, or reviewers",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/pullrequests/*/",
          method: "PUT",
        },
        {
          id: "comment_pull_request",
          name: "Comment on pull request",
          description: "Add a comment to a pull request",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/pullrequests/*/comments/",
          method: "POST",
        },
        {
          id: "approve_pull_request",
          name: "Approve pull request",
          description: "Approve a pull request, or withdraw an approval",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/pullrequests/*/approve",
          methods: ["POST", "DELETE"],
        },
        {
          id: "merge_pull_request",
          name: "Merge pull request",
          description: "Merge a pull request",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/pullrequests/*/merge",
          method: "POST",
        },
        {
          id: "decline_pull_request",
          name: "Decline pull request",
          description: "Decline (close) a pull request without merging",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/pullrequests/*/decline",
          method: "POST",
        },
        {
          id: "create_branch",
          name: "Create branch",
          description: "Create a new branch",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/refs/branches/",
          method: "POST",
        },
        {
          id: "delete_branch",
          name: "Delete branch",
          description: "Delete a branch",
          hostPattern: "api.bitbucket.org",
          pathPattern: "/2.0/repositories/*/*/refs/branches/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
