import type { AppPermissionDefinition } from "./types";

// Fireflies exposes a single GraphQL endpoint (POST /graphql); queries and
// mutations share the same host/path/method and are discriminated by the
// fail-closed body classifier (`graphqlOps`): the query row matches only
// provably pure query documents, the mutation row everything else. The hosted
// MCP server lives on the same host and uses the same bearer key; its row
// sits in the write group because the server exposes write tools (share
// meeting, update title, create soundbite, …).
export const firefliesPermissions: AppPermissionDefinition = {
  provider: "fireflies",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "graphql_query",
          name: "GraphQL API (queries)",
          description:
            "Query meetings, transcripts, summaries, and action items. Anything that isn't clearly a pure query counts as a mutation.",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
          graphqlOps: "query",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "graphql_mutation",
          name: "GraphQL API (mutations)",
          description:
            "Upload audio, update titles, share meetings, delete transcripts. Blocking this blocks every GraphQL request that isn't a pure query.",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
          graphqlOps: "mutation",
        },
        {
          id: "mcp_access",
          name: "MCP server",
          description:
            "Read and modify meeting data (search transcripts, share meetings, update titles) through the hosted Fireflies MCP server.",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/mcp",
        },
      ],
    },
  ],
};
