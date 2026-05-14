import type { AppPermissionDefinition } from "./types";

export const googleDocsPermissions: AppPermissionDefinition = {
  provider: "google-docs",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_document",
          name: "Get document",
          description: "Retrieve the contents of a document",
          hostPattern: "docs.googleapis.com",
          pathPattern: "/v1/documents/*",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_document",
          name: "Create document",
          description: "Create a new Google Docs document",
          hostPattern: "docs.googleapis.com",
          pathPattern: "/v1/documents",
          method: "POST",
        },
        {
          id: "batch_update_document",
          name: "Batch update document",
          description: "Apply a batch of updates to a document",
          hostPattern: "docs.googleapis.com",
          pathPattern: "/v1/documents/*:batchUpdate",
          method: "POST",
        },
      ],
    },
  ],
};
