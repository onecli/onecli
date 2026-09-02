import type { AppPermissionDefinition } from "./types";

export const granolaPermissions: AppPermissionDefinition = {
  provider: "granola",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_notes",
          name: "List notes",
          description: "List meeting notes with optional filters",
          hostPattern: "public-api.granola.ai",
          pathPattern: "/v1/notes",
          method: "GET",
        },
        {
          id: "get_note",
          name: "Get note",
          description: "Retrieve a specific meeting note by ID",
          hostPattern: "public-api.granola.ai",
          pathPattern: "/v1/notes/*",
          method: "GET",
        },
        {
          id: "list_folders",
          name: "List folders",
          description: "List note folders",
          hostPattern: "public-api.granola.ai",
          pathPattern: "/v1/folders",
          method: "GET",
        },
      ],
    },
  ],
};
