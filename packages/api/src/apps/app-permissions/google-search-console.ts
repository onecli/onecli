import type { AppPermissionDefinition } from "./types";

export const googleSearchConsolePermissions: AppPermissionDefinition = {
  provider: "google-search-console",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "search_analytics_query",
          name: "Search analytics query",
          description: "Query search analytics data for a site",
          hostPattern: "searchconsole.googleapis.com",
          pathPattern: "/webmasters/v3/sites/*/searchAnalytics/query",
          method: "POST",
        },
        {
          id: "list_sites",
          name: "List sites",
          description: "List all sites in Search Console",
          hostPattern: "searchconsole.googleapis.com",
          pathPattern: "/webmasters/v3/sites",
          method: "GET",
        },
        {
          id: "get_site",
          name: "Get site",
          description: "Retrieve details for a specific site",
          hostPattern: "searchconsole.googleapis.com",
          pathPattern: "/webmasters/v3/sites/*",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "add_site",
          name: "Add site",
          description: "Add a site to Search Console",
          hostPattern: "searchconsole.googleapis.com",
          pathPattern: "/webmasters/v3/sites/*",
          method: "PUT",
        },
        {
          id: "delete_site",
          name: "Delete site",
          description: "Remove a site from Search Console",
          hostPattern: "searchconsole.googleapis.com",
          pathPattern: "/webmasters/v3/sites/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
