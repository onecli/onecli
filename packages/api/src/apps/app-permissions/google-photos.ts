import type { AppPermissionDefinition } from "./types";

export const googlePhotosPermissions: AppPermissionDefinition = {
  provider: "google-photos",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_media_items",
          name: "List media items",
          description: "List media items in the library",
          hostPattern: "photoslibrary.googleapis.com",
          pathPattern: "/v1/mediaItems",
          method: "GET",
        },
        {
          id: "get_media_item",
          name: "Get media item",
          description: "Retrieve a specific media item",
          hostPattern: "photoslibrary.googleapis.com",
          pathPattern: "/v1/mediaItems/*",
          method: "GET",
        },
        {
          id: "list_albums",
          name: "List albums",
          description: "List albums in the library",
          hostPattern: "photoslibrary.googleapis.com",
          pathPattern: "/v1/albums",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "upload_media",
          name: "Upload media",
          description: "Upload a media item to the library",
          hostPattern: "photoslibrary.googleapis.com",
          pathPattern: "/v1/uploads",
          method: "POST",
        },
        {
          id: "create_album",
          name: "Create album",
          description: "Create a new album",
          hostPattern: "photoslibrary.googleapis.com",
          pathPattern: "/v1/albums",
          method: "POST",
        },
        {
          id: "batch_add_to_album",
          name: "Batch add to album",
          description: "Add media items to an album",
          hostPattern: "photoslibrary.googleapis.com",
          pathPattern: "/v1/albums/*:batchAddMediaItems",
          method: "POST",
        },
      ],
    },
  ],
};
