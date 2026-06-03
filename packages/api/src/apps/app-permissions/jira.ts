import type { AppPermissionDefinition } from "./types";

export const jiraPermissions: AppPermissionDefinition = {
  provider: "jira",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description:
          "Search, read, and list issues, projects, users, and metadata",
        hostPattern: "api.atlassian.com",
        pathPattern: "/ex/jira/*/rest/api/3/*",
        method: "GET",
      },
      tools: [
        {
          id: "search_issues",
          name: "Search issues",
          description: "Search for issues using JQL",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/search",
          method: "GET",
        },
        {
          id: "get_issue",
          name: "Get issue",
          description: "Retrieve a specific issue and its sub-resources",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/issue/*",
          method: "GET",
        },
        {
          id: "list_projects",
          name: "List projects",
          description: "List all projects in the Jira instance",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/project",
          method: "GET",
        },
        {
          id: "get_project",
          name: "Get project",
          description: "Retrieve a specific project's details",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/project/*",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      wildcard: {
        id: "write_all",
        name: "All write operations",
        description: "Create, update, delete, transition, and assign issues",
        hostPattern: "api.atlassian.com",
        pathPattern: "/ex/jira/*/rest/api/3/*",
        methods: ["POST", "PUT", "PATCH", "DELETE"],
      },
      tools: [
        {
          id: "create_issue",
          name: "Create issue",
          description: "Create a new Jira issue",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/issue",
          method: "POST",
        },
        {
          id: "update_issue",
          name: "Update issue",
          description: "Update an existing Jira issue",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/issue/*",
          method: "PUT",
        },
        {
          id: "add_comment",
          name: "Add comment",
          description: "Add a comment to a Jira issue",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/issue/*/comment",
          method: "POST",
        },
        {
          id: "transition_issue",
          name: "Transition issue",
          description: "Transition an issue to a new status",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/issue/*/transitions",
          method: "POST",
        },
        {
          id: "delete_issue",
          name: "Delete issue",
          description: "Delete an existing Jira issue",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/issue/*",
          method: "DELETE",
        },
        {
          id: "assign_issue",
          name: "Assign issue",
          description: "Assign or unassign a user to an issue",
          hostPattern: "api.atlassian.com",
          pathPattern: "/ex/jira/*/rest/api/3/issue/*/assignee",
          method: "PUT",
        },
      ],
    },
  ],
};
