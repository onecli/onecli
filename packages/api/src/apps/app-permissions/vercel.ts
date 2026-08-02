import type { AppPermissionDefinition } from "./types";

export const vercelPermissions: AppPermissionDefinition = {
  provider: "vercel",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "list_deployments",
          name: "List Deployments",
          description: "List and view deployment status and details.",
          hostPattern: "api.vercel.com",
          pathPattern: "/v6/deployments*",
          method: "GET",
        },
        {
          id: "get_project",
          name: "Get Project Config",
          description: "Read project configurations and metadata.",
          hostPattern: "api.vercel.com",
          pathPattern: "/v9/projects/*",
          method: "GET",
        },
        {
          id: "get_env_vars",
          name: "Read Environment Variables",
          description: "Fetch environment variables for a project.",
          hostPattern: "api.vercel.com",
          pathPattern: "/v9/projects/*/env*",
          method: "GET",
        },
        {
          id: "get_deployment_logs",
          name: "Get Deployment Logs",
          description: "Fetch build and event logs for a deployment.",
          hostPattern: "api.vercel.com",
          pathPattern: "/v2/deployments/*/events*",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "trigger_deployment",
          name: "Trigger Deployment",
          description: "Create and trigger new deployments.",
          hostPattern: "api.vercel.com",
          pathPattern: "/v13/deployments*",
          method: "POST",
        },
        {
          id: "cancel_deployment",
          name: "Cancel Deployment",
          description: "Cancel or delete an active deployment.",
          hostPattern: "api.vercel.com",
          pathPattern: "/v13/deployments/*",
          method: "DELETE",
        },
        {
          id: "manage_env_vars",
          name: "Manage Environment Variables",
          description: "Create or update environment variables for projects.",
          hostPattern: "api.vercel.com",
          pathPattern: "/v10/projects/*/env*",
          method: "POST",
        },
      ],
    },
  ],
};
