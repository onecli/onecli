import type { AppPermissionDefinition, AppTool } from "./types";

// Zendesk Support + Help Center REST API (developer.zendesk.com/api-reference).
// Every account answers on its own `<subdomain>.zendesk.com`; the gateway pins
// the token to the connection's one host, so the tool host is the zone.
//
// Path discipline (see `salesforce.ts`): a terminal wildcard segment carries a
// trailing slash so it pins depth instead of becoming a raw prefix. Zendesk
// accepts every path with or without a `.json` suffix, so each tool aliases
// both spellings.
const HOST = "*.zendesk.com";

// Numeric-prefix globs exclude named bulk/action routes. The trailing slash
// pins item depth, including `.json`, without changing the shared matcher.
const itemPatterns = (resource: string): string[] =>
  Array.from({ length: 10 }, (_, digit) => `/api/v2/${resource}/${digit}*/`);

const tool = (t: Omit<AppTool, "hostPattern">): AppTool => ({
  ...t,
  hostPattern: HOST,
});

export const zendeskPermissions: AppPermissionDefinition = {
  provider: "zendesk",
  groups: [
    {
      category: "read",
      tools: [
        tool({
          id: "list_tickets",
          name: "List tickets",
          description: "List support tickets",
          pathPattern: "/api/v2/tickets",
          aliasPatterns: ["/api/v2/tickets.json"],
          method: "GET",
        }),
        tool({
          id: "get_ticket",
          name: "Get ticket",
          description: "Retrieve a specific ticket",
          pathPattern: "/api/v2/tickets/0*/",
          aliasPatterns: itemPatterns("tickets").slice(1),
          method: "GET",
        }),
        tool({
          id: "list_ticket_comments",
          name: "List ticket comments",
          description: "Read the conversation on a ticket",
          pathPattern: "/api/v2/tickets/*/comments",
          aliasPatterns: ["/api/v2/tickets/*/comments.json"],
          method: "GET",
        }),
        tool({
          id: "list_users",
          name: "List users",
          description: "List users and agents",
          pathPattern: "/api/v2/users",
          aliasPatterns: ["/api/v2/users.json"],
          method: "GET",
        }),
        tool({
          id: "get_user",
          name: "Get user",
          description: "Retrieve a specific user",
          pathPattern: "/api/v2/users/0*/",
          aliasPatterns: [
            ...itemPatterns("users").slice(1),
            "/api/v2/users/me",
            "/api/v2/users/me.json",
          ],
          method: "GET",
        }),
        tool({
          id: "list_organizations",
          name: "List organizations",
          description: "List organizations",
          pathPattern: "/api/v2/organizations",
          aliasPatterns: ["/api/v2/organizations.json"],
          method: "GET",
        }),
        tool({
          id: "get_organization",
          name: "Get organization",
          description: "Retrieve a specific organization",
          pathPattern: "/api/v2/organizations/0*/",
          aliasPatterns: itemPatterns("organizations").slice(1),
          method: "GET",
        }),
        tool({
          id: "get_job_status",
          name: "Get job status",
          description:
            "Read completion and results of an asynchronous operation",
          pathPattern: "/api/v2/job_statuses/*/",
          method: "GET",
        }),
        tool({
          id: "search",
          name: "Search",
          description: "Search tickets, users, and organizations",
          pathPattern: "/api/v2/search",
          aliasPatterns: ["/api/v2/search.json"],
          method: "GET",
        }),
        tool({
          id: "list_articles",
          name: "List articles",
          description: "List Help Center articles",
          pathPattern: "/api/v2/help_center/*/articles",
          aliasPatterns: [
            "/api/v2/help_center/*/articles.json",
            "/api/v2/help_center/articles",
            "/api/v2/help_center/articles.json",
          ],
          method: "GET",
        }),
      ],
    },
    {
      category: "write",
      tools: [
        tool({
          id: "create_ticket",
          name: "Create ticket",
          description: "Create a new support ticket",
          pathPattern: "/api/v2/tickets",
          aliasPatterns: ["/api/v2/tickets.json"],
          method: "POST",
        }),
        tool({
          id: "update_ticket",
          name: "Update tickets",
          description: "Update or comment on a ticket, or update many at once",
          pathPattern: "/api/v2/tickets/0*/",
          aliasPatterns: [
            ...itemPatterns("tickets").slice(1),
            "/api/v2/tickets/update_many",
            "/api/v2/tickets/update_many.json",
          ],
          method: "PUT",
        }),
        tool({
          id: "merge_tickets",
          name: "Merge tickets",
          description: "Merge tickets into one (the merged tickets are closed)",
          pathPattern: "/api/v2/tickets/*/merge",
          aliasPatterns: ["/api/v2/tickets/*/merge.json"],
          method: "POST",
        }),
        tool({
          id: "mark_ticket_spam",
          name: "Mark tickets as spam",
          description:
            "Delete one or many tickets as spam and suspend their requesters",
          pathPattern: "/api/v2/tickets/*/mark_as_spam",
          aliasPatterns: [
            "/api/v2/tickets/*/mark_as_spam.json",
            "/api/v2/tickets/mark_many_as_spam",
            "/api/v2/tickets/mark_many_as_spam.json",
          ],
          method: "PUT",
        }),
        tool({
          id: "delete_tickets",
          name: "Delete tickets",
          description: "Delete one ticket, or many at once",
          pathPattern: "/api/v2/tickets/0*/",
          aliasPatterns: [
            ...itemPatterns("tickets").slice(1),
            "/api/v2/tickets/destroy_many",
            "/api/v2/tickets/destroy_many.json",
          ],
          method: "DELETE",
        }),
        tool({
          id: "create_user",
          name: "Create user",
          description: "Create a new user",
          pathPattern: "/api/v2/users",
          aliasPatterns: ["/api/v2/users.json"],
          method: "POST",
        }),
        tool({
          id: "update_user",
          name: "Update user",
          description: "Update an existing user",
          pathPattern: "/api/v2/users/0*/",
          aliasPatterns: itemPatterns("users").slice(1),
          method: "PUT",
        }),
        tool({
          id: "delete_user",
          name: "Delete user",
          description: "Delete a user (their tickets stay)",
          pathPattern: "/api/v2/users/0*/",
          aliasPatterns: itemPatterns("users").slice(1),
          method: "DELETE",
        }),
        tool({
          id: "create_article",
          name: "Create article",
          description: "Create a Help Center article",
          pathPattern: "/api/v2/help_center/*/sections/*/articles",
          aliasPatterns: [
            "/api/v2/help_center/*/sections/*/articles.json",
            "/api/v2/help_center/sections/*/articles",
            "/api/v2/help_center/sections/*/articles.json",
          ],
          method: "POST",
        }),
      ],
    },
  ],
};
