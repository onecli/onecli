import type { AppPermissionDefinition } from "./types";

export const fathomPermissions: AppPermissionDefinition = {
  provider: "fathom",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_meetings",
          name: "List meetings",
          description: "List recorded meetings",
          hostPattern: "api.fathom.ai",
          pathPattern: "/external/v1/meetings",
          method: "GET",
        },
        {
          id: "get_recording_summary",
          name: "Get recording summary",
          description: "Retrieve the summary for a recording",
          hostPattern: "api.fathom.ai",
          pathPattern: "/external/v1/recordings/*/summary",
          method: "GET",
        },
        {
          id: "get_recording_transcript",
          name: "Get recording transcript",
          description: "Retrieve the transcript for a recording",
          hostPattern: "api.fathom.ai",
          pathPattern: "/external/v1/recordings/*/transcript",
          method: "GET",
        },
        {
          id: "list_teams",
          name: "List teams",
          description: "List teams in the account",
          hostPattern: "api.fathom.ai",
          pathPattern: "/external/v1/teams",
          method: "GET",
        },
        {
          id: "list_team_members",
          name: "List team members",
          description: "List members of a team",
          hostPattern: "api.fathom.ai",
          pathPattern: "/external/v1/team_members",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_webhook",
          name: "Create webhook",
          description: "Register a webhook for event notifications",
          hostPattern: "api.fathom.ai",
          pathPattern: "/external/v1/webhooks",
          method: "POST",
        },
        {
          id: "delete_webhook",
          name: "Delete webhook",
          description: "Remove a registered webhook",
          hostPattern: "api.fathom.ai",
          pathPattern: "/external/v1/webhooks/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
