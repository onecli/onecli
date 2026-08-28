import type { AppPermissionDefinition } from "./types";

export const linearPermissions: AppPermissionDefinition = {
  provider: "linear",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_issues",
          name: "List issues",
          description: "List and filter issues",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
        },
        {
          id: "get_issue",
          name: "Get issue",
          description: "Retrieve a specific issue",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
        },
        {
          id: "list_projects",
          name: "List projects",
          description: "List all projects",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
        },
        {
          id: "list_teams",
          name: "List teams",
          description: "List workspace teams",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
        },
        {
          id: "list_labels",
          name: "List labels",
          description: "List issue labels",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
        },
        {
          id: "search",
          name: "Search",
          description: "Search issues and projects",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_issue",
          name: "Create issue",
          description: "Create a new issue",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
        },
        {
          id: "update_issue",
          name: "Update issue",
          description: "Update an existing issue",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
        },
        {
          id: "create_comment",
          name: "Create comment",
          description: "Add a comment to an issue",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
        },
        {
          id: "delete_issue",
          name: "Delete issue",
          description: "Delete an issue",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
        },
      ],
    },
  ],
};
