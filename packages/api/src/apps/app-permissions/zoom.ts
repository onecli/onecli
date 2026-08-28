import type { AppPermissionDefinition } from "./types";

export const zoomPermissions: AppPermissionDefinition = {
  provider: "zoom",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_meetings",
          name: "List meetings",
          description: "List scheduled and past meetings for a user",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/users/*/meetings",
          method: "GET",
        },
        {
          id: "get_meeting",
          name: "Get meeting",
          description: "Get meeting details by ID",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/meetings/*",
          method: "GET",
        },
        {
          id: "get_user",
          name: "Get user profile",
          description: "Get the authenticated user's profile",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/users/me",
          method: "GET",
        },
        {
          id: "list_recordings",
          name: "List recordings",
          description: "List cloud recordings for a user",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/users/*/recordings",
          method: "GET",
        },
        {
          id: "get_recording_files",
          name: "Get recording files",
          description: "Get recording files for a meeting",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/meetings/*/recordings",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_meeting",
          name: "Create meeting",
          description: "Schedule a new meeting",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/users/*/meetings",
          method: "POST",
        },
        {
          id: "update_meeting",
          name: "Update meeting",
          description: "Update an existing meeting",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/meetings/*",
          method: "PATCH",
        },
        {
          id: "delete_meeting",
          name: "Delete meeting",
          description: "Delete a meeting",
          hostPattern: "api.zoom.us",
          pathPattern: "/v2/meetings/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
