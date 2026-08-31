import type { AppPermissionDefinition } from "./types";

// Linear's API is a single GraphQL endpoint (POST /graphql). Every read tool
// is tagged `graphqlOps: "query"` and every write tool `"mutation"`, so the
// fail-closed body classifier discriminates them: read rows match only
// provably pure query documents; write rows govern everything else. Within a
// kind the tools remain aliases of the same endpoint (allowing one read tool
// allows all reads) - per-field granularity is not modeled.
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
          graphqlOps: "query",
        },
        {
          id: "get_issue",
          name: "Get issue",
          description: "Retrieve a specific issue",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
          graphqlOps: "query",
        },
        {
          id: "list_projects",
          name: "List projects",
          description: "List all projects",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
          graphqlOps: "query",
        },
        {
          id: "list_teams",
          name: "List teams",
          description: "List workspace teams",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
          graphqlOps: "query",
        },
        {
          id: "list_labels",
          name: "List labels",
          description: "List issue labels",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
          graphqlOps: "query",
        },
        {
          id: "search",
          name: "Search",
          description: "Search issues and projects",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
          graphqlOps: "query",
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
          graphqlOps: "mutation",
        },
        {
          id: "update_issue",
          name: "Update issue",
          description: "Update an existing issue",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
          graphqlOps: "mutation",
        },
        {
          id: "create_comment",
          name: "Create comment",
          description: "Add a comment to an issue",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
          graphqlOps: "mutation",
        },
        {
          id: "delete_issue",
          name: "Delete issue",
          description: "Delete an issue",
          hostPattern: "api.linear.app",
          pathPattern: "/graphql",
          graphqlOps: "mutation",
        },
      ],
    },
  ],
};
