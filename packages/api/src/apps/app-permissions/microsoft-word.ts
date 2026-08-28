import type { AppPermissionDefinition } from "./types";

export const microsoftWordPermissions: AppPermissionDefinition = {
  provider: "microsoft-word",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_files",
          name: "List files",
          description: "List files and folders in OneDrive",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/drive/root/children",
          method: "GET",
        },
        {
          id: "get_file",
          name: "Get file metadata",
          description: "Get metadata for a specific file",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/drive/items/*",
          method: "GET",
        },
        {
          id: "download_file",
          name: "Download file",
          description: "Download the contents of a file",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/drive/items/*/content",
          method: "GET",
        },
        {
          id: "search_files",
          name: "Search files",
          description: "Search for files in OneDrive",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/drive/root/search(*)",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "upload_file",
          name: "Upload file",
          description: "Upload or replace a file in OneDrive",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/drive/items/*/content",
          method: "PUT",
        },
        {
          id: "create_folder",
          name: "Create folder",
          description: "Create a new folder in OneDrive",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/drive/root/children",
          method: "POST",
        },
        {
          id: "update_file",
          name: "Update file metadata",
          description: "Rename or move a file",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/drive/items/*",
          method: "PATCH",
        },
        {
          id: "delete_file",
          name: "Delete file",
          description: "Delete a file from OneDrive",
          hostPattern: "graph.microsoft.com",
          pathPattern: "/v1.0/me/drive/items/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
