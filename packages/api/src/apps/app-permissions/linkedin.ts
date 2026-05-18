import type { AppPermissionDefinition } from "./types";

export const linkedinPermissions: AppPermissionDefinition = {
  provider: "linkedin",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_profile",
          name: "Read profile",
          description: "Get the authenticated user's profile information",
          hostPattern: "api.linkedin.com",
          pathPattern: "/v2/userinfo",
          method: "GET",
        },
        {
          id: "get_posts",
          name: "List posts",
          description: "List posts by the authenticated user",
          hostPattern: "api.linkedin.com",
          pathPattern: "/rest/posts*",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_post",
          name: "Create post",
          description: "Create a new post on LinkedIn",
          hostPattern: "api.linkedin.com",
          pathPattern: "/rest/posts",
          method: "POST",
        },
        {
          id: "delete_post",
          name: "Delete post",
          description: "Delete an existing post",
          hostPattern: "api.linkedin.com",
          pathPattern: "/rest/posts/*",
          method: "DELETE",
        },
        {
          id: "create_comment",
          name: "Create comment",
          description: "Comment on a post",
          hostPattern: "api.linkedin.com",
          pathPattern: "/rest/socialActions/*/comments",
          method: "POST",
        },
        {
          id: "create_reaction",
          name: "React to post",
          description: "Add a reaction to a post",
          hostPattern: "api.linkedin.com",
          pathPattern: "/rest/reactions*",
          method: "POST",
        },
      ],
    },
  ],
};
