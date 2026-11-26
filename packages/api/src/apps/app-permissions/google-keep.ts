import type { AppPermissionDefinition } from "./types";

// The Keep API has no update method: a note can be listed, read, created,
// deleted, and shared, but never edited in place.
export const googleKeepPermissions: AppPermissionDefinition = {
  provider: "google-keep",
  unlistedReads: "allow",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_notes",
          name: "List notes",
          description: "List notes and lists",
          hostPattern: "keep.googleapis.com",
          pathPattern: "/v1/notes",
          method: "GET",
        },
        {
          id: "get_note",
          name: "Get note",
          description: "Retrieve a specific note or list",
          hostPattern: "keep.googleapis.com",
          // Trailing slash = this depth only, so attachments stay their own tool.
          pathPattern: "/v1/notes/*/",
          method: "GET",
        },
        {
          id: "download_attachment",
          name: "Download attachment",
          description: "Download an attachment of a note",
          hostPattern: "keep.googleapis.com",
          pathPattern: "/v1/notes/*/attachments/*",
          // Google's Java client fetches the bytes (`alt=media`) from the
          // media download path; the other clients use the plain path.
          aliasPatterns: ["/download/v1/notes/*/attachments/*"],
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_note",
          name: "Create note",
          description: "Create a new note or list",
          hostPattern: "keep.googleapis.com",
          pathPattern: "/v1/notes",
          method: "POST",
        },
        {
          id: "delete_note",
          name: "Delete note",
          description: "Permanently delete a note (cannot be undone)",
          hostPattern: "keep.googleapis.com",
          pathPattern: "/v1/notes/*/",
          method: "DELETE",
        },
        {
          id: "share_note",
          name: "Share note",
          description: "Add collaborators to a note",
          hostPattern: "keep.googleapis.com",
          pathPattern: "/v1/notes/*/permissions:batchCreate",
          method: "POST",
        },
        {
          id: "unshare_note",
          name: "Unshare note",
          description: "Remove collaborators from a note",
          hostPattern: "keep.googleapis.com",
          pathPattern: "/v1/notes/*/permissions:batchDelete",
          method: "POST",
        },
      ],
    },
  ],
};
