import type { AppPermissionDefinition } from "./types";

/**
 * MantisBT's REST API lives under /api/rest/ and uses GET for reads and
 * POST/PATCH/DELETE for mutations, so both umbrellas are true supersets of
 * their groups. Host is the connection's own `<name>.mantishub.io` tenant —
 * the gateway additionally gates injection to the stored host, so these
 * patterns use the suffix host the rules engine matches on.
 */
export const mantishubPermissions: AppPermissionDefinition = {
  provider: "mantishub",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description: "Every read endpoint on the MantisBT REST API",
        hostPattern: "*.mantishub.io",
        pathPattern: "/api/rest/*",
        method: "GET",
      },
      tools: [
        {
          id: "read_issues",
          name: "Read issues",
          description: "List, retrieve, and filter issues and their notes",
          hostPattern: "*.mantishub.io",
          pathPattern: "/api/rest/issues",
          aliasPatterns: ["/api/rest/issues/*"],
          method: "GET",
        },
        {
          id: "read_projects",
          name: "Read projects",
          description: "List and retrieve projects, versions, and categories",
          hostPattern: "*.mantishub.io",
          pathPattern: "/api/rest/projects",
          aliasPatterns: ["/api/rest/projects/*"],
          method: "GET",
        },
        {
          id: "read_filters",
          name: "Read filters",
          description: "List saved filters",
          hostPattern: "*.mantishub.io",
          pathPattern: "/api/rest/filters",
          aliasPatterns: ["/api/rest/filters/*"],
          method: "GET",
        },
        {
          id: "read_users",
          name: "Read users",
          description: "Read the token's own user and look up users",
          hostPattern: "*.mantishub.io",
          pathPattern: "/api/rest/users/me",
          aliasPatterns: ["/api/rest/users/*"],
          method: "GET",
        },
        {
          id: "read_config",
          name: "Read configuration",
          description: "Read tracker configuration and localized strings",
          hostPattern: "*.mantishub.io",
          pathPattern: "/api/rest/config",
          aliasPatterns: [
            "/api/rest/config/*",
            "/api/rest/lang",
            "/api/rest/lang/*",
          ],
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      wildcard: {
        id: "write_all",
        name: "All write operations",
        description: "Every mutating endpoint on the MantisBT REST API",
        hostPattern: "*.mantishub.io",
        pathPattern: "/api/rest/*",
        methods: ["POST", "PATCH", "DELETE"],
      },
      tools: [
        {
          id: "manage_issues",
          name: "Manage issues",
          description:
            "Create, update, and delete issues — including notes, tags, attachments, relationships, and monitors",
          hostPattern: "*.mantishub.io",
          pathPattern: "/api/rest/issues",
          aliasPatterns: ["/api/rest/issues/*"],
          methods: ["POST", "PATCH", "DELETE"],
        },
        {
          id: "manage_projects",
          name: "Manage projects",
          description:
            "Create, update, and delete projects, versions, and categories",
          hostPattern: "*.mantishub.io",
          pathPattern: "/api/rest/projects",
          aliasPatterns: ["/api/rest/projects/*"],
          methods: ["POST", "PATCH", "DELETE"],
        },
      ],
    },
  ],
};
