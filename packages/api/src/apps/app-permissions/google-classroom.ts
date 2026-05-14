import type { AppPermissionDefinition } from "./types";

export const googleClassroomPermissions: AppPermissionDefinition = {
  provider: "google-classroom",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_courses",
          name: "List courses",
          description: "List courses the user has access to",
          hostPattern: "classroom.googleapis.com",
          pathPattern: "/v1/courses",
          method: "GET",
        },
        {
          id: "get_course",
          name: "Get course",
          description: "Retrieve a specific course",
          hostPattern: "classroom.googleapis.com",
          pathPattern: "/v1/courses/*",
          method: "GET",
        },
        {
          id: "list_students",
          name: "List students",
          description: "List students enrolled in a course",
          hostPattern: "classroom.googleapis.com",
          pathPattern: "/v1/courses/*/students",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "create_course",
          name: "Create course",
          description: "Create a new course",
          hostPattern: "classroom.googleapis.com",
          pathPattern: "/v1/courses",
          method: "POST",
        },
        {
          id: "update_course",
          name: "Update course",
          description: "Update an existing course",
          hostPattern: "classroom.googleapis.com",
          pathPattern: "/v1/courses/*",
          method: "PATCH",
        },
        {
          id: "create_coursework",
          name: "Create coursework",
          description: "Create a new coursework assignment",
          hostPattern: "classroom.googleapis.com",
          pathPattern: "/v1/courses/*/courseWork",
          method: "POST",
        },
      ],
    },
  ],
};
