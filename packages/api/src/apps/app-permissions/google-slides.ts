import type { AppPermissionDefinition } from "./types";

export const googleSlidesPermissions: AppPermissionDefinition = {
  provider: "google-slides",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_presentation",
          name: "Get presentation",
          description: "Retrieve a presentation and its properties",
          hostPattern: "slides.googleapis.com",
          pathPattern: "/v1/presentations/*",
          method: "GET",
        },
        {
          id: "get_page",
          name: "Get page",
          description: "Retrieve a specific page from a presentation",
          hostPattern: "slides.googleapis.com",
          pathPattern: "/v1/presentations/*/pages/*",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_presentation",
          name: "Create presentation",
          description: "Create a new Google Slides presentation",
          hostPattern: "slides.googleapis.com",
          pathPattern: "/v1/presentations",
          method: "POST",
        },
        {
          id: "batch_update_presentation",
          name: "Batch update presentation",
          description: "Apply a batch of updates to a presentation",
          hostPattern: "slides.googleapis.com",
          pathPattern: "/v1/presentations/*:batchUpdate",
          method: "POST",
        },
      ],
    },
  ],
};
