import type { AppPermissionDefinition } from "./types";

export const todoistPermissions: AppPermissionDefinition = {
  provider: "todoist",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_tasks",
          name: "List tasks",
          description: "List active tasks",
          hostPattern: "api.todoist.com",
          pathPattern: "/api/v1/tasks",
          method: "GET",
        },
        {
          id: "get_task",
          name: "Get task",
          description: "Retrieve a specific task",
          hostPattern: "api.todoist.com",
          pathPattern: "/api/v1/tasks/*",
          method: "GET",
        },
        {
          id: "list_projects",
          name: "List projects",
          description: "List all projects",
          hostPattern: "api.todoist.com",
          pathPattern: "/api/v1/projects",
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
          description: "Create a new task",
          hostPattern: "api.todoist.com",
          pathPattern: "/api/v1/tasks",
          method: "POST",
        },
        {
          id: "update_task",
          name: "Update task",
          description: "Update an existing task",
          hostPattern: "api.todoist.com",
          pathPattern: "/api/v1/tasks/*",
          method: "POST",
        },
        {
          id: "close_task",
          name: "Close task",
          description: "Mark a task as complete",
          hostPattern: "api.todoist.com",
          pathPattern: "/api/v1/tasks/*/close",
          method: "POST",
        },
        {
          id: "delete_task",
          name: "Delete task",
          description: "Delete a task",
          hostPattern: "api.todoist.com",
          pathPattern: "/api/v1/tasks/*",
          method: "DELETE",
        },
      ],
    },
  ],
};
