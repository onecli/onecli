import type { AppPermissionDefinition } from "./types";

export const googleChatPermissions: AppPermissionDefinition = {
  provider: "google-chat",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_spaces",
          name: "List spaces",
          description: "List Chat spaces the user is a member of",
          hostPattern: "chat.googleapis.com",
          pathPattern: "/v1/spaces",
          method: "GET",
        },
        {
          id: "get_space",
          name: "Get space",
          description: "Retrieve details of a Chat space",
          hostPattern: "chat.googleapis.com",
          pathPattern: "/v1/spaces/*",
          method: "GET",
        },
        {
          id: "list_members",
          name: "List members",
          description: "List members of a Chat space",
          hostPattern: "chat.googleapis.com",
          pathPattern: "/v1/spaces/*/members",
          method: "GET",
        },
        {
          id: "list_messages",
          name: "List messages",
          description: "List messages in a Chat space",
          hostPattern: "chat.googleapis.com",
          pathPattern: "/v1/spaces/*/messages",
          method: "GET",
        },
        {
          id: "get_message",
          name: "Get message",
          description: "Retrieve a specific message",
          hostPattern: "chat.googleapis.com",
          pathPattern: "/v1/spaces/*/messages/*",
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
          description: "Create a new Chat space",
          hostPattern: "chat.googleapis.com",
          pathPattern: "/v1/spaces",
          method: "POST",
        },
        {
          id: "create_message",
          name: "Send message",
          description: "Send a message to a Chat space",
          hostPattern: "chat.googleapis.com",
          pathPattern: "/v1/spaces/*/messages",
          method: "POST",
        },
        {
          id: "delete_message",
          name: "Delete message",
          description: "Delete a message from a Chat space",
          hostPattern: "chat.googleapis.com",
          pathPattern: "/v1/spaces/*/messages/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
