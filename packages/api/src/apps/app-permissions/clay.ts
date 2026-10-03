import type { AppPermissionDefinition } from "./types";

// Clay Public API (https://developers.clay.com/api-reference).
const HOST = "api.clay.com";

export const clayPermissions: AppPermissionDefinition = {
  provider: "clay",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_me",
          name: "Get current user",
          description: "View the connected user and workspace",
          hostPattern: HOST,
          pathPattern: "/public/v0/me",
          method: "GET",
        },
        {
          id: "get_credit_balance",
          name: "Get credit balance",
          description: "View the workspace's remaining credits",
          hostPattern: HOST,
          pathPattern: "/public/v0/credits/balance",
          method: "GET",
        },
        {
          id: "search",
          name: "Search people and companies",
          description: "Search Clay's GTM database and page through results",
          hostPattern: HOST,
          pathPattern: "/public/v0/search/query-mode",
          aliasPatterns: [
            "/public/v0/search/query-mode/*/run",
            "/public/v0/search/filters-mode",
            "/public/v0/search/filters-mode/*/run",
          ],
          method: "POST",
        },
        {
          id: "search_reference",
          name: "Get search reference",
          description:
            "Read the search and workflow-run query grammars and filter fields",
          hostPattern: HOST,
          pathPattern: "/public/v0/search/query-mode/reference",
          aliasPatterns: [
            "/public/v0/search/filters-mode/fields",
            "/public/v0/workflows/runs/query/reference",
          ],
          method: "GET",
        },
        {
          id: "query_tables",
          name: "Query tables",
          description: "Read rows from Clay tables (Enterprise)",
          hostPattern: HOST,
          pathPattern: "/public/v0/tables/query",
          method: "POST",
        },
        {
          id: "get_routine_results",
          name: "Get routine results",
          description: "Check progress and results of a routine run",
          hostPattern: HOST,
          pathPattern: "/public/v0/routines/run/*/results",
          aliasPatterns: ["/public/v0/routines/run-batch/*/results"],
          method: "GET",
        },
        {
          id: "search_workflow_runs",
          name: "Search workflow runs",
          description: "Search past workflow runs",
          hostPattern: HOST,
          pathPattern: "/public/v0/workflows/runs/query",
          method: "POST",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "run_routine",
          name: "Run routine",
          description:
            "Run an enrichment function or workflow on 1-100 items (uses Clay credits)",
          hostPattern: HOST,
          pathPattern: "/public/v0/routines/*/run",
          method: "POST",
        },
        {
          id: "run_routine_batch",
          name: "Run routine batch",
          description:
            "Upload a file and run a routine over it (uses Clay credits)",
          hostPattern: HOST,
          pathPattern: "/public/v0/routines/*/run-batch/start",
          aliasPatterns: ["/public/v0/routines/*/run-batch/upload-url"],
          method: "POST",
        },
      ],
    },
  ],
};
