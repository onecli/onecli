import type { AppPermissionDefinition } from "./types";

export const googleAdminPermissions: AppPermissionDefinition = {
  provider: "google-admin",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_users",
          name: "List users",
          description: "List users in the directory",
          hostPattern: "admin.googleapis.com",
          pathPattern: "/admin/directory/v1/users",
          method: "GET",
        },
        {
          id: "get_user",
          name: "Get user",
          description: "Retrieve a specific user from the directory",
          hostPattern: "admin.googleapis.com",
          pathPattern: "/admin/directory/v1/users/*",
          method: "GET",
        },
        {
          id: "list_groups",
          name: "List groups",
          description: "List groups in the directory",
          hostPattern: "admin.googleapis.com",
          pathPattern: "/admin/directory/v1/groups",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_user",
          name: "Create user",
          description: "Create a new user in the directory",
          hostPattern: "admin.googleapis.com",
          pathPattern: "/admin/directory/v1/users",
          method: "POST",
        },
        {
          id: "update_user",
          name: "Update user",
          description: "Update an existing user in the directory",
          hostPattern: "admin.googleapis.com",
          pathPattern: "/admin/directory/v1/users/*",
          method: "PUT",
        },
        {
          id: "delete_user",
          name: "Delete user",
          description: "Delete a user from the directory",
          hostPattern: "admin.googleapis.com",
          pathPattern: "/admin/directory/v1/users/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
