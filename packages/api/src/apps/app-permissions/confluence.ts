import type { AppPermissionDefinition } from "./types";

export const confluencePermissions: AppPermissionDefinition = {
  provider: "confluence",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description:
          "Search, read, and list pages, spaces, comments, and attachments",
        hostPattern: "api.atlassian.com",
        pathPattern: "/wiki/api/v2/*",
        method: "GET",
      },
      tools: [
        {
          id: "get_page",
          name: "Get page",
          description: "Retrieve a specific Confluence page",
          hostPattern: "api.atlassian.com",
          pathPattern: "/wiki/api/v2/pages/*",
          method: "GET",
        },
        {
          id: "search_content",
          name: "Search content",
          description: "Search for content using CQL",
          hostPattern: "api.atlassian.com",
          pathPattern: "/wiki/api/v2/search",
          method: "GET",
        },
        {
          id: "list_spaces",
          name: "List spaces",
          description: "List all spaces in Confluence",
          hostPattern: "api.atlassian.com",
          pathPattern: "/wiki/api/v2/spaces",
          method: "GET",
        },
        {
          id: "get_space",
          name: "Get space",
          description: "Retrieve a specific space's details",
          hostPattern: "api.atlassian.com",
          pathPattern: "/wiki/api/v2/spaces/*",
          method: "GET",
        },
        {
          id: "list_pages",
          name: "List pages",
          description: "List pages in a space",
          hostPattern: "api.atlassian.com",
          pathPattern: "/wiki/api/v2/spaces/*/pages",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      wildcard: {
        id: "write_all",
        name: "All write operations",
        description: "Create, update, delete pages, and add comments",
        hostPattern: "api.atlassian.com",
        pathPattern: "/wiki/api/v2/*",
        methods: ["POST", "PUT", "PATCH", "DELETE"],
      },
      tools: [
        {
          id: "create_page",
          name: "Create page",
          description: "Create a new Confluence page",
          hostPattern: "api.atlassian.com",
          pathPattern: "/wiki/api/v2/pages",
          method: "POST",
        },
        {
          id: "update_page",
          name: "Update page",
          description: "Update an existing Confluence page",
          hostPattern: "api.atlassian.com",
          pathPattern: "/wiki/api/v2/pages/*",
          method: "PUT",
        },
        {
          id: "delete_page",
          name: "Delete page",
          description: "Delete a Confluence page",
          hostPattern: "api.atlassian.com",
          pathPattern: "/wiki/api/v2/pages/*",
          method: "DELETE",
        },
        {
          id: "create_comment",
          name: "Add comment",
          description: "Add a comment to a Confluence page",
          hostPattern: "api.atlassian.com",
          pathPattern: "/wiki/api/v2/pages/*/footer-comments",
          method: "POST",
        },
      ],
    },
  ],
};
