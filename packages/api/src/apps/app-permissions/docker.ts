import type { AppPermissionDefinition } from "./types";

export const dockerPermissions: AppPermissionDefinition = {
  provider: "docker",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_repositories",
          name: "List repositories",
          description: "List repositories in a namespace",
          hostPattern: "hub.docker.com",
          pathPattern: "/v2/namespaces/*/repositories",
          method: "GET",
        },
        {
          id: "get_repository",
          name: "Get repository",
          description: "Get repository details",
          hostPattern: "hub.docker.com",
          pathPattern: "/v2/namespaces/*/repositories/*",
          method: "GET",
        },
        {
          id: "list_tags",
          name: "List tags",
          description: "List tags for a repository",
          hostPattern: "hub.docker.com",
          pathPattern: "/v2/namespaces/*/repositories/*/tags",
          method: "GET",
        },
        {
          id: "get_namespace",
          name: "Get namespace",
          description: "Get namespace information",
          hostPattern: "hub.docker.com",
          pathPattern: "/v2/namespaces/*",
          method: "GET",
        },
        {
          id: "get_user",
          name: "Get user info",
          description: "Get user profile information",
          hostPattern: "hub.docker.com",
          pathPattern: "/v2/users/*",
          method: "GET",
        },
        {
          id: "list_orgs",
          name: "List organizations",
          description: "List organizations the user belongs to",
          hostPattern: "hub.docker.com",
          pathPattern: "/v2/user/orgs",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_repository",
          name: "Create repository",
          description: "Create a new repository",
          hostPattern: "hub.docker.com",
          pathPattern: "/v2/namespaces/*/repositories",
          method: "POST",
        },
        {
          id: "update_repository",
          name: "Update repository",
          description: "Update repository settings",
          hostPattern: "hub.docker.com",
          pathPattern: "/v2/repositories/*/*",
          method: "PATCH",
        },
        {
          id: "delete_repository",
          name: "Delete repository",
          description: "Delete a repository",
          hostPattern: "hub.docker.com",
          pathPattern: "/v2/repositories/*/*",
          method: "DELETE",
        },
        {
          id: "delete_tag",
          name: "Delete tag",
          description: "Delete a tag from a repository",
          hostPattern: "hub.docker.com",
          pathPattern: "/v2/repositories/*/*/tags/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
