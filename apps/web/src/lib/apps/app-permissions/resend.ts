import type { AppPermissionDefinition } from "./types";

export const resendPermissions: AppPermissionDefinition = {
  provider: "resend",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_email",
          name: "Get email",
          description: "Retrieve a specific sent email",
          hostPattern: "api.resend.com",
          pathPattern: "/emails/*",
          method: "GET",
        },
        {
          id: "list_emails",
          name: "List emails",
          description: "List sent emails",
          hostPattern: "api.resend.com",
          pathPattern: "/emails",
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
          description: "Send a new email via Resend",
          hostPattern: "api.resend.com",
          pathPattern: "/emails",
          method: "POST",
        },
        {
          id: "create_batch",
          name: "Create batch",
          description: "Send a batch of emails",
          hostPattern: "api.resend.com",
          pathPattern: "/emails/batch",
          method: "POST",
        },
      ],
    },
  ],
};
