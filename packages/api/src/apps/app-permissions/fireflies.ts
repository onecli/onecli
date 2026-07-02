import type { AppPermissionDefinition } from "./types";

/**
 * Fireflies.ai is a single GraphQL endpoint, so every tool targets
 * POST api.fireflies.ai/graphql. The read/write split mirrors GraphQL
 * queries vs. mutations (cf. the monday.com connector).
 */
export const firefliesPermissions: AppPermissionDefinition = {
  provider: "fireflies",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "query_transcripts",
          name: "Query transcripts",
          description:
            "List and read meeting transcripts, summaries, sentences, and speakers",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "query_users",
          name: "Query users",
          description: "Read user profiles, teams, and user groups",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "query_bites",
          name: "Query soundbites",
          description: "List and read soundbites (bites)",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "query_meetings",
          name: "Query live meetings",
          description: "Read active meetings and live action items",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "query_analytics",
          name: "Query analytics",
          description:
            "Read conversation analytics, AI App outputs, and audit events",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "query_askfred",
          name: "Query AskFred",
          description: "Read AskFred AI conversation threads",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "query_contacts",
          name: "Query contacts and channels",
          description: "List and read contacts and channels",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "upload_audio",
          name: "Upload audio",
          description: "Upload audio or video for transcription",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "manage_meetings",
          name: "Manage meetings",
          description:
            "Add the Fireflies bot to live meetings and update meeting titles, privacy, channels, and recording state",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "create_bites",
          name: "Create soundbites",
          description: "Create bites, live soundbites, and live action items",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "share_meetings",
          name: "Share meetings",
          description: "Share meeting transcripts and revoke shared access",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "manage_askfred",
          name: "Manage AskFred",
          description:
            "Create, continue, and delete AskFred conversation threads",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "set_user_role",
          name: "Set user roles",
          description: "Assign roles to team members",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "delete_transcript",
          name: "Delete transcript",
          description: "Delete meeting transcripts",
          hostPattern: "api.fireflies.ai",
          pathPattern: "/graphql",
          method: "POST",
        },
      ],
    },
  ],
};
