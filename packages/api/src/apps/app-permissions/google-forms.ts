import type { AppPermissionDefinition } from "./types";

export const googleFormsPermissions: AppPermissionDefinition = {
  provider: "google-forms",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_form",
          name: "Get form",
          description: "Retrieve a form and its structure",
          hostPattern: "forms.googleapis.com",
          pathPattern: "/v1/forms/*",
          method: "GET",
        },
        {
          id: "list_responses",
          name: "List responses",
          description: "List responses submitted to a form",
          hostPattern: "forms.googleapis.com",
          pathPattern: "/v1/forms/*/responses",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_form",
          name: "Create form",
          description: "Create a new Google Form",
          hostPattern: "forms.googleapis.com",
          pathPattern: "/v1/forms",
          method: "POST",
        },
        {
          id: "batch_update_form",
          name: "Batch update form",
          description: "Apply a batch of updates to a form",
          hostPattern: "forms.googleapis.com",
          pathPattern: "/v1/forms/*:batchUpdate",
          method: "POST",
        },
      ],
    },
  ],
};
