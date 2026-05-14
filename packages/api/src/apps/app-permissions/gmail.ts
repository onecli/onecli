import type { AppPermissionDefinition } from "./types";

export const gmailPermissions: AppPermissionDefinition = {
  provider: "gmail",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "search_threads",
          name: "Search email threads",
          description: "Search for threads matching a query",
          hostPattern: "gmail.googleapis.com",
          pathPattern: "/gmail/v1/users/*/threads",
          method: "GET",
        },
        {
          id: "get_thread",
          name: "Read email thread",
          description: "Retrieve a specific email thread",
          hostPattern: "gmail.googleapis.com",
          pathPattern: "/gmail/v1/users/*/threads/*",
          method: "GET",
        },
        {
          id: "get_message",
          name: "Read email message",
          description: "Retrieve a specific email message",
          hostPattern: "gmail.googleapis.com",
          pathPattern: "/gmail/v1/users/*/messages/*",
          method: "GET",
        },
        {
          id: "list_labels",
          name: "List labels",
          description: "List all labels in the mailbox",
          hostPattern: "gmail.googleapis.com",
          pathPattern: "/gmail/v1/users/*/labels",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "send_email",
          name: "Send email",
          description: "Send email on your behalf",
          hostPattern: "gmail.googleapis.com",
          pathPattern: "/gmail/v1/users/*/messages/send",
          method: "POST",
        },
        {
          id: "create_draft",
          name: "Create draft",
          description: "Create a new draft email",
          hostPattern: "gmail.googleapis.com",
          pathPattern: "/gmail/v1/users/*/drafts",
          method: "POST",
        },
        {
          id: "modify_message",
          name: "Modify message",
          description: "Add or remove labels on a message",
          hostPattern: "gmail.googleapis.com",
          pathPattern: "/gmail/v1/users/*/messages/*/modify",
          method: "POST",
        },
        {
          id: "trash_message",
          name: "Trash message",
          description: "Move a message to trash",
          hostPattern: "gmail.googleapis.com",
          pathPattern: "/gmail/v1/users/*/messages/*/trash",
          method: "POST",
        },
      ],
    },
  ],
};
