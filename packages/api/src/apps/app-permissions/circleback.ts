import type { AppPermissionDefinition } from "./types";

// Circleback REST API (https://circleback.ai/docs/api), every path from its
// published OpenAPI (circleback.ai/docs/api/openapi.json), base /api.
//
// The API shares its host with the Circleback web app, so the gateway injects
// the key under /api/ only (see the gateway host rule). The hosted MCP server
// at /api/mcp authenticates with its own OAuth (dynamic client registration),
// not the API key, so it is not cataloged here.
//
// Single-item paths end in `*/`: one segment exactly (with or without the
// trailing slash), never deeper. `/api/meeting/*` would also match
// `/api/meeting/{id}/transcript` and `/share`, so "Get meeting" would leak
// transcripts and "Delete meeting" would answer the share route.
const HOST = "circleback.ai";

export const circlebackPermissions: AppPermissionDefinition = {
  provider: "circleback",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_meetings",
          name: "List meetings",
          description:
            "List meetings, filtered by owner, status, tag, or attendee",
          hostPattern: HOST,
          pathPattern: "/api/meetings",
          method: "GET",
        },
        {
          id: "search_meetings",
          name: "Search meetings",
          description: "Search meetings by name and content",
          hostPattern: HOST,
          pathPattern: "/api/search",
          method: "GET",
        },
        {
          id: "get_meeting",
          name: "Get meeting",
          description: "Read a meeting's notes, action items, and attendees",
          hostPattern: HOST,
          pathPattern: "/api/meeting/*/",
          method: "GET",
        },
        {
          id: "get_transcript",
          name: "Get transcript",
          description:
            "Read a meeting's transcript with speakers and timestamps",
          hostPattern: HOST,
          pathPattern: "/api/meeting/*/transcript",
          method: "GET",
        },
        {
          id: "list_action_items",
          name: "List action items",
          description: "Find action items by status, assignee, tag, or meeting",
          hostPattern: HOST,
          pathPattern: "/api/action-items",
          method: "GET",
        },
        {
          id: "list_calendar_events",
          name: "List calendar events",
          description: "View upcoming and past calendar events",
          hostPattern: HOST,
          pathPattern: "/api/calendar/events",
          method: "GET",
        },
        {
          id: "list_people",
          name: "List people",
          description: "List people you've met with",
          hostPattern: HOST,
          pathPattern: "/api/people",
          method: "GET",
        },
        {
          id: "get_person",
          name: "Get person",
          description: "Read a person's profile and meeting history",
          hostPattern: HOST,
          pathPattern: "/api/person/*/",
          method: "GET",
        },
        {
          id: "list_companies",
          name: "List companies",
          description: "List companies you've met with",
          hostPattern: HOST,
          pathPattern: "/api/companies",
          method: "GET",
        },
        {
          id: "get_company",
          name: "Get company",
          description: "Read a company's details and related meetings",
          hostPattern: HOST,
          pathPattern: "/api/company/*/",
          method: "GET",
        },
        {
          id: "list_tags",
          name: "List tags",
          description: "View the tags in your workspace",
          hostPattern: HOST,
          pathPattern: "/api/tag",
          method: "GET",
        },
        {
          id: "get_account",
          name: "Get account",
          description: "View the connected account's email",
          hostPattern: HOST,
          pathPattern: "/api/oauth/test",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "update_meeting",
          name: "Update meeting",
          description: "Change a meeting's name, notes, or tags",
          hostPattern: HOST,
          pathPattern: "/api/meeting/*/",
          method: "PUT",
        },
        {
          id: "share_meeting",
          name: "Share meeting",
          description:
            "Share a meeting with people, teams, or the link, or remove access",
          hostPattern: HOST,
          pathPattern: "/api/meeting/*/share",
          method: "PUT",
        },
        {
          id: "delete_meeting",
          name: "Delete meeting",
          description: "Delete a meeting",
          hostPattern: HOST,
          pathPattern: "/api/meeting/*/",
          method: "DELETE",
        },
        {
          id: "import_meeting",
          name: "Import meeting",
          description:
            "Import a meeting with its notes, transcript, and attendees",
          hostPattern: HOST,
          pathPattern: "/api/meetings",
          method: "POST",
        },
        {
          id: "update_calendar_event_meeting",
          name: "Add notes to a calendar event",
          description:
            "Set private notes or tags on the meeting for a calendar event",
          hostPattern: HOST,
          pathPattern: "/api/calendar/events/*/meeting",
          method: "PUT",
        },
        {
          id: "create_action_item",
          name: "Create action item",
          description: "Add an action item",
          hostPattern: HOST,
          pathPattern: "/api/action-items",
          method: "POST",
        },
        {
          id: "update_action_item",
          name: "Update action item",
          description: "Change an action item, like marking it done",
          hostPattern: HOST,
          pathPattern: "/api/action-item/*/",
          method: "PUT",
        },
        {
          id: "delete_action_item",
          name: "Delete action item",
          description: "Delete an action item",
          hostPattern: HOST,
          pathPattern: "/api/action-item/*/",
          method: "DELETE",
        },
        {
          id: "manage_tags",
          name: "Manage tags",
          description: "Create, rename, or delete tags",
          hostPattern: HOST,
          pathPattern: "/api/tag",
          aliasPatterns: ["/api/tag/*/"],
          methods: ["POST", "PUT", "DELETE"],
        },
      ],
    },
  ],
};
