import type { AppPermissionDefinition } from "./types";

export const googleCalendarPermissions: AppPermissionDefinition = {
  provider: "google-calendar",
  groups: [
    {
      category: "read",
      wildcard: {
        id: "read_all",
        name: "All read operations",
        description: "List and read events, calendars, and settings",
        hostPattern: "www.googleapis.com",
        pathPattern: "/calendar/v3/*",
        method: "GET",
      },
      tools: [
        {
          id: "list_events",
          name: "List events",
          description: "List events on a calendar",
          hostPattern: "www.googleapis.com",
          pathPattern: "/calendar/v3/calendars/*/events",
          method: "GET",
        },
        {
          id: "get_event",
          name: "Get event",
          description: "Retrieve a specific calendar event",
          hostPattern: "www.googleapis.com",
          pathPattern: "/calendar/v3/calendars/*/events/*",
          method: "GET",
        },
        {
          id: "list_calendars",
          name: "List calendars",
          description: "List all calendars for the user",
          hostPattern: "www.googleapis.com",
          pathPattern: "/calendar/v3/users/me/calendarList",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      wildcard: {
        id: "write_all",
        name: "All write operations",
        description: "Create, update, and delete events and calendars",
        hostPattern: "www.googleapis.com",
        pathPattern: "/calendar/v3/*",
        methods: ["POST", "PUT", "PATCH", "DELETE"],
      },
      tools: [
        {
          id: "create_event",
          name: "Create event",
          description: "Create a new calendar event",
          hostPattern: "www.googleapis.com",
          pathPattern: "/calendar/v3/calendars/*/events",
          method: "POST",
        },
        {
          id: "update_event",
          name: "Update event",
          description: "Update an existing calendar event",
          hostPattern: "www.googleapis.com",
          pathPattern: "/calendar/v3/calendars/*/events/*",
          method: "PATCH",
        },
        {
          id: "delete_event",
          name: "Delete event",
          description: "Delete a calendar event",
          hostPattern: "www.googleapis.com",
          pathPattern: "/calendar/v3/calendars/*/events/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
