import type { AppPermissionDefinition } from "./types";

export const googleDrivePermissions: AppPermissionDefinition = {
  provider: "google-drive",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_files",
          name: "List files",
          description: "List files in Google Drive",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files",
          method: "GET",
        },
        {
          id: "get_file",
          name: "Get file",
          description: "Download a file from Google Drive",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*",
          method: "GET",
        },
        {
          id: "get_file_metadata",
          name: "Get file metadata",
          description: "Retrieve metadata for a specific file",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*",
          method: "GET",
        },
        {
          id: "search_files",
          name: "Search files",
          description: "Search for files matching a query",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_file",
          name: "Create file",
          description: "Upload a new file to Google Drive",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files",
          method: "POST",
        },
        {
          id: "update_file",
          name: "Update file",
          description: "Update an existing file in Google Drive",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*",
          method: "PATCH",
        },
        {
          id: "delete_file",
          name: "Delete file",
          description: "Delete a file from Google Drive",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*",
          method: "DELETE",
        },
        {
          id: "share_file",
          name: "Share file",
          description: "Create a permission to share a file",
          hostPattern: "www.googleapis.com",
          pathPattern: "/drive/v3/files/*/permissions",
          method: "POST",
        },
      ],
    },
  ],
};
