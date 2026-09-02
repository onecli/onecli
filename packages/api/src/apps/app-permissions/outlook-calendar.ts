import type { AppPermissionDefinition } from "./types";

export const outlookCalendarPermissions: AppPermissionDefinition = {
  provider: "outlook-calendar",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_events",
          name: "List events",
          description: "List events on a calendar",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/calendars/*/events",
          method: "GET",
        },
        {
          id: "list_default_events",
          name: "List default calendar events",
          description: "List events on the default calendar",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events",
          method: "GET",
        },
        {
          id: "get_event",
          name: "Get event",
          description: "Retrieve a specific calendar event",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events/*",
          method: "GET",
        },
        {
          id: "list_calendars",
          name: "List calendars",
          description: "List all calendars for the user",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/calendars",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_event",
          name: "Create event",
          description: "Create a new calendar event",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events",
          method: "POST",
        },
        {
          id: "update_event",
          name: "Update event",
          description: "Update an existing calendar event",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events/*",
          method: "PATCH",
        },
        {
          id: "delete_event",
          name: "Delete event",
          description: "Delete a calendar event",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events/*",
          method: "DELETE",
        },
        {
          id: "respond_event",
          name: "Respond to event",
          description: "Accept, tentatively accept, or decline an event",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/events/*/accept",
          aliasPatterns: [
            "/v1.0/me/events/*/decline",
            "/v1.0/me/events/*/tentativelyAccept",
          ],
          method: "POST",
        },
      ],
    },
  ],
};
