import type { AppPermissionDefinition } from "./types";

export const youtubePermissions: AppPermissionDefinition = {
  provider: "youtube",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_videos",
          name: "List videos",
          description: "List videos matching specified criteria",
          hostPattern: "www.googleapis.com",
          pathPattern: "/youtube/v3/videos",
          method: "GET",
        },
        {
          id: "search",
          name: "Search",
          description: "Search for videos, channels, and playlists",
          hostPattern: "www.googleapis.com",
          pathPattern: "/youtube/v3/search",
          method: "GET",
        },
        {
          id: "list_channels",
          name: "List channels",
          description: "List channel details",
          hostPattern: "www.googleapis.com",
          pathPattern: "/youtube/v3/channels",
          method: "GET",
        },
        {
          id: "list_playlists",
          name: "List playlists",
          description: "List playlists for a channel",
          hostPattern: "www.googleapis.com",
          pathPattern: "/youtube/v3/playlists",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "insert_video",
          name: "Insert video",
          description: "Upload a new video to YouTube",
          hostPattern: "www.googleapis.com",
          pathPattern: "/upload/youtube/v3/videos",
          method: "POST",
        },
        {
          id: "update_video",
          name: "Update video",
          description: "Update a video's metadata",
          hostPattern: "www.googleapis.com",
          pathPattern: "/youtube/v3/videos",
          method: "PUT",
        },
        {
          id: "delete_video",
          name: "Delete video",
          description: "Delete a video from YouTube",
          hostPattern: "www.googleapis.com",
          pathPattern: "/youtube/v3/videos",
          method: "DELETE",
        },
        {
          id: "insert_comment",
          name: "Insert comment",
          description: "Post a comment on a video",
          hostPattern: "www.googleapis.com",
          pathPattern: "/youtube/v3/commentThreads",
          method: "POST",
        },
      ],
    },
  ],
};
