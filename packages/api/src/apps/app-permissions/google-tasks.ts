import type { AppPermissionDefinition } from "./types";

export const googleTasksPermissions: AppPermissionDefinition = {
  provider: "google-tasks",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_task_lists",
          name: "List task lists",
          description: "List all task lists for the user",
          hostPattern: "tasks.googleapis.com",
          pathPattern: "/tasks/v1/users/@me/lists",
          method: "GET",
        },
        {
          id: "list_tasks",
          name: "List tasks",
          description: "List tasks in a task list",
          hostPattern: "tasks.googleapis.com",
          pathPattern: "/tasks/v1/lists/*/tasks",
          method: "GET",
        },
        {
          id: "get_task",
          name: "Get task",
          description: "Retrieve a specific task",
          hostPattern: "tasks.googleapis.com",
          pathPattern: "/tasks/v1/lists/*/tasks/*",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_task",
          name: "Create task",
          description: "Create a new task in a task list",
          hostPattern: "tasks.googleapis.com",
          pathPattern: "/tasks/v1/lists/*/tasks",
          method: "POST",
        },
        {
          id: "update_task",
          name: "Update task",
          description: "Update an existing task",
          hostPattern: "tasks.googleapis.com",
          pathPattern: "/tasks/v1/lists/*/tasks/*",
          methods: ["PUT", "PATCH"],
        },
        {
          id: "delete_task",
          name: "Delete task",
          description: "Delete a task from a task list",
          hostPattern: "tasks.googleapis.com",
          pathPattern: "/tasks/v1/lists/*/tasks/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
