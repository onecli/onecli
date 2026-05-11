import type { AppPermissionDefinition } from "./types";

export const githubPermissions: AppPermissionDefinition = {
  provider: "github",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_repos",
          name: "List repositories",
          description: "List repositories for the authenticated user",
          hostPattern: "api.github.com",
          pathPattern: "/user/repos",
          method: "GET",
        },
        {
          id: "get_repo",
          name: "Read repository",
          description: "Get repository details, files, and metadata",
          hostPattern: "api.github.com",
          pathPattern: "/repos/*/*",
          method: "GET",
        },
        {
          id: "list_issues",
          name: "List issues",
          description: "List issues in a repository",
          hostPattern: "api.github.com",
          pathPattern: "/repos/*/issues",
          method: "GET",
        },
        {
          id: "list_pulls",
          name: "List pull requests",
          description: "List pull requests in a repository",
          hostPattern: "api.github.com",
          pathPattern: "/repos/*/pulls",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_issue",
          name: "Create issue",
          description: "Create a new issue in a repository",
          hostPattern: "api.github.com",
          pathPattern: "/repos/*/issues",
          method: "POST",
        },
        {
          id: "create_pull",
          name: "Create pull request",
          description: "Create a new pull request",
          hostPattern: "api.github.com",
          pathPattern: "/repos/*/pulls",
          method: "POST",
        },
        {
          id: "create_comment",
          name: "Create comment",
          description: "Comment on an issue or pull request",
          hostPattern: "api.github.com",
          pathPattern: "/repos/*/issues/*/comments",
          method: "POST",
        },
        {
          id: "delete_branch",
          name: "Delete branch",
          description: "Delete a git branch reference",
          hostPattern: "api.github.com",
          pathPattern: "/repos/*/git/refs/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
