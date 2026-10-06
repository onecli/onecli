import type { AppPermissionDefinition } from "./types";

// Timeless REST API (https://docs.timeless.day/api-reference), every path
// from its published OpenAPI (docs.timeless.day/openapi.json), base /v1,
// plus the hosted MCP server, which shares the host and the same API token
// (docs.timeless.day/api-reference/mcp).
const HOST = "api.timeless.day";

export const timelessPermissions: AppPermissionDefinition = {
  provider: "timeless",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_meetings",
          name: "List meetings",
          description:
            "Search and filter recorded meetings by date, participant, company, or room",
          hostPattern: HOST,
          pathPattern: "/v1/meetings",
          method: "GET",
        },
        {
          id: "list_upcoming_meetings",
          name: "List upcoming meetings",
          description: "View scheduled events from the connected calendar",
          hostPattern: HOST,
          pathPattern: "/v1/meetings/upcoming",
          method: "GET",
        },
        {
          id: "get_transcript",
          name: "Get transcript",
          description:
            "Read a meeting's transcript with speakers and timestamps",
          hostPattern: HOST,
          pathPattern: "/v1/meetings/*/transcript",
          method: "GET",
        },
        {
          id: "get_recording",
          name: "Get recording",
          description:
            "Get a short-lived download link for a meeting recording",
          hostPattern: HOST,
          pathPattern: "/v1/meetings/*/recording",
          method: "GET",
        },
        {
          id: "get_document",
          name: "Get document",
          description:
            "Read an AI-generated summary, action items, or notes from a meeting",
          hostPattern: HOST,
          pathPattern: "/v1/documents/*",
          method: "GET",
        },
        {
          id: "list_rooms",
          name: "List rooms",
          description: "View the rooms that group related meetings",
          hostPattern: HOST,
          pathPattern: "/v1/rooms",
          method: "GET",
        },
        {
          id: "list_meeting_permissions",
          name: "List meeting sharing",
          description: "View who a meeting you own is shared with",
          hostPattern: HOST,
          pathPattern: "/v1/meetings/*/permissions",
          method: "GET",
        },
        {
          id: "get_notetaker_automation",
          name: "Get note-taker automation",
          description:
            "View when the note-taker joins your meetings automatically",
          hostPattern: HOST,
          pathPattern: "/v1/settings/notetaker-automation",
          method: "GET",
        },
        {
          id: "list_webhooks",
          name: "List webhooks",
          description: "View webhook subscriptions",
          hostPattern: HOST,
          pathPattern: "/v1/webhooks",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "schedule_bot",
          name: "Schedule note-taker",
          description: "Send the note-taker to an upcoming calendar event",
          hostPattern: HOST,
          pathPattern: "/v1/meetings/*/bot",
          method: "POST",
        },
        {
          id: "cancel_bot",
          name: "Cancel note-taker",
          description: "Cancel a scheduled note-taker for an event",
          hostPattern: HOST,
          pathPattern: "/v1/meetings/*/bot",
          method: "DELETE",
        },
        {
          id: "send_bot_to_link",
          name: "Send note-taker to a link",
          description: "Send the note-taker to a meeting link right now",
          hostPattern: HOST,
          pathPattern: "/v1/meetings/bot",
          method: "POST",
        },
        {
          id: "upload_media",
          name: "Upload recording",
          description: "Upload an audio or video file to be transcribed",
          hostPattern: HOST,
          pathPattern: "/v1/meetings/upload",
          method: "PUT",
        },
        {
          id: "set_meeting_permission",
          name: "Share meeting",
          description:
            "Share a meeting you own with a teammate, your team, or anyone with the link",
          hostPattern: HOST,
          pathPattern: "/v1/meetings/*/permissions",
          method: "POST",
        },
        {
          id: "revoke_meeting_permission",
          name: "Unshare meeting",
          description: "Remove someone's access to a meeting you own",
          hostPattern: HOST,
          pathPattern: "/v1/meetings/*/permissions/*",
          method: "DELETE",
        },
        {
          id: "set_notetaker_automation",
          name: "Change note-taker automation",
          description:
            "Change when the note-taker joins automatically (schedules or cancels bots for upcoming events)",
          hostPattern: HOST,
          pathPattern: "/v1/settings/notetaker-automation",
          method: "PUT",
        },
        {
          id: "manage_webhooks",
          name: "Manage webhooks",
          description: "Create, update, or delete webhook subscriptions",
          hostPattern: HOST,
          pathPattern: "/v1/webhooks",
          aliasPatterns: ["/v1/webhooks/*"],
          methods: ["POST", "PATCH", "DELETE"],
        },
        // The gateway injects the token on every path of the host, so the MCP
        // server is reachable with it too. It exposes the same writes as the
        // REST tools above (send the note-taker, set automation, manage
        // webhooks) behind one endpoint, so it sits in the write group as its
        // own toggle, mirroring Fireflies, rather than escaping every per-tool
        // rule. Any method: MCP's HTTP transport uses POST for calls, GET for
        // the event stream and DELETE to end a session.
        {
          id: "mcp_access",
          name: "MCP server",
          description:
            "Read and modify meeting data (search meetings, send the note-taker, manage webhooks) through the hosted Timeless MCP server",
          hostPattern: HOST,
          pathPattern: "/mcp/*",
        },
      ],
    },
  ],
};
