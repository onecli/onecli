import type { AppPermissionDefinition } from "./types";

// Fireflies exposes a single GraphQL endpoint (POST /graphql), so queries and
// mutations share the same host/path/method. The read/write split below is
// advisory (for the UI) — a rule on either row matches all of /graphql, so
// restricting one restricts both — the same limitation GitHub's GraphQL tools
// accept. The hosted MCP server lives on the same host and uses the same
// bearer key; its row sits in the write group because the server exposes
// write tools (share meeting, update title, create soundbite, …).
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
            "Query meetings, transcripts, summaries, and action items via the Fireflies GraphQL API. Queries and mutations share one endpoint, so restricting this also restricts mutations.",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
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
            "Upload audio, update meeting titles, share meetings, and delete transcripts via the Fireflies GraphQL API. Queries and mutations share one endpoint, so restricting this also restricts queries.",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "mcp_access",
          name: "MCP server",
          description:
            "Read and modify meeting data (search transcripts, share meetings, update titles, create soundbites) through the hosted Fireflies MCP server.",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/mcp",
        },
      ],
    },
  ],
};
