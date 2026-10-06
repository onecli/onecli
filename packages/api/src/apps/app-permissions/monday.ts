import type { AppPermissionDefinition } from "./types";

// Monday's API is a single GraphQL endpoint (POST /v2). Every read tool is
// tagged `graphqlOps: "query"` and every write tool `"mutation"`, so the
// fail-closed body classifier discriminates them: read rows match only
// provably pure query documents; write rows govern everything else. Without
// the tags all ten rows were the same request, so a rule naming only the
// write tools also decided every read. Within a kind the tools remain aliases
// of the same endpoint (allowing one read tool allows all reads).

export const mondayPermissions: AppPermissionDefinition = {
  provider: "monday",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "query_boards",
          name: "Query boards",
          description: "List and read boards, items, and columns",
          hostPattern: "api.monday.com",
          pathPattern: "/v2",
          method: "POST",
          graphqlOps: "query",
        },
        {
          id: "query_users",
          name: "Query users",
          description: "List and read user profiles",
          hostPattern: "api.monday.com",
          pathPattern: "/v2",
          method: "POST",
          graphqlOps: "query",
        },
        {
          id: "query_docs",
          name: "Query docs",
          description: "List and read documents",
          hostPattern: "api.monday.com",
          pathPattern: "/v2",
          method: "POST",
          graphqlOps: "query",
        },
        {
          id: "query_updates",
          name: "Query updates",
          description: "List and read comments and updates",
          hostPattern: "api.monday.com",
          pathPattern: "/v2",
          method: "POST",
          graphqlOps: "query",
        },
        {
          id: "query_workspaces",
          name: "Query workspaces",
          description: "List and read workspaces",
          hostPattern: "api.monday.com",
          pathPattern: "/v2",
          method: "POST",
          graphqlOps: "query",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "mutate_boards",
          name: "Modify boards",
          description: "Create, update, and delete boards and items",
          hostPattern: "api.monday.com",
          pathPattern: "/v2",
          method: "POST",
          graphqlOps: "mutation",
        },
        {
          id: "mutate_docs",
          name: "Modify docs",
          description: "Create and edit documents",
          hostPattern: "api.monday.com",
          pathPattern: "/v2",
          method: "POST",
          graphqlOps: "mutation",
        },
        {
          id: "mutate_updates",
          name: "Modify updates",
          description: "Post, edit, and delete comments and updates",
          hostPattern: "api.monday.com",
          pathPattern: "/v2",
          method: "POST",
          graphqlOps: "mutation",
        },
        {
          id: "manage_webhooks",
          name: "Manage webhooks",
          description: "Create and delete webhook configurations",
          hostPattern: "api.monday.com",
          pathPattern: "/v2",
          method: "POST",
          graphqlOps: "mutation",
        },
        {
          id: "send_notifications",
          name: "Send notifications",
          description: "Send notifications to users",
          hostPattern: "api.monday.com",
          pathPattern: "/v2",
          method: "POST",
          graphqlOps: "mutation",
        },
      ],
    },
  ],
};
