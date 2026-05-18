import type { AppPermissionDefinition, AppToolGroup } from "./types";

const gitlabGroups: AppToolGroup[] = [
  {
    category: "read",
    tools: [
      {
        id: "list_projects",
        name: "List projects",
        description: "List projects accessible to the authenticated user",
        hostPattern: "gitlab.com",
        pathPattern: "/api/v4/projects",
        method: "GET",
      },
      {
        id: "get_project",
        name: "Read project",
        description: "Get project details, files, and metadata",
        hostPattern: "gitlab.com",
        pathPattern: "/api/v4/projects/*",
        method: "GET",
      },
      {
        id: "list_issues",
        name: "List issues",
        description: "List issues in a project",
        hostPattern: "gitlab.com",
        pathPattern: "/api/v4/projects/*/issues",
        method: "GET",
      },
      {
        id: "list_merge_requests",
        name: "List merge requests",
        description: "List merge requests in a project",
        hostPattern: "gitlab.com",
        pathPattern: "/api/v4/projects/*/merge_requests",
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
        description: "Create a new issue in a project",
        hostPattern: "gitlab.com",
        pathPattern: "/api/v4/projects/*/issues",
        method: "POST",
      },
      {
        id: "create_merge_request",
        name: "Create merge request",
        description: "Create a new merge request",
        hostPattern: "gitlab.com",
        pathPattern: "/api/v4/projects/*/merge_requests",
        method: "POST",
      },
      {
        id: "create_issue_note",
        name: "Create comment",
        description: "Comment on an issue",
        hostPattern: "gitlab.com",
        pathPattern: "/api/v4/projects/*/issues/*/notes",
        method: "POST",
      },
      {
        id: "delete_branch",
        name: "Delete branch",
        description: "Delete a git branch",
        hostPattern: "gitlab.com",
        pathPattern: "/api/v4/projects/*/repository/branches/*",
        method: "DELETE",
      },
    ],
  },
];

export const gitlabPermissions: AppPermissionDefinition = {
  provider: "gitlab",
  groups: gitlabGroups,
};
