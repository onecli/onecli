import type { AppPermissionDefinition } from "./types";

export const googleMeetPermissions: AppPermissionDefinition = {
  provider: "google-meet",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_space",
          name: "Get space",
          description: "Retrieve a meeting space",
          hostPattern: "meet.googleapis.com",
          pathPattern: "/v2/spaces/*",
          method: "GET",
        },
        {
          id: "list_recordings",
          name: "List recordings",
          description: "List recordings for a conference",
          hostPattern: "meet.googleapis.com",
          pathPattern: "/v2/conferenceRecords/*/recordings",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_space",
          name: "Create space",
          description: "Create a new meeting space",
          hostPattern: "meet.googleapis.com",
          pathPattern: "/v2/spaces",
          method: "POST",
        },
        {
          id: "end_call",
          name: "End call",
          description: "End an active conference call",
          hostPattern: "meet.googleapis.com",
          pathPattern: "/v2/spaces/*:endActiveConference",
          method: "POST",
        },
      ],
    },
  ],
};
