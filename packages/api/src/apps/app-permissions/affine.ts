import type { AppPermissionDefinition } from "./types";

/**
 * AFFiNE runs on a per-deployment host; "*" matches any host here because the
 * gateway already restricts injection to the AFFINE_HOST instance, and the
 * stored `host` credential field gates each connection.
 *
 * AFFiNE's API is GraphQL-first: queries and mutations share POST /graphql,
 * so the GraphQL tool lives in the write group (it can mutate). REST GETs
 * (session info, blob/doc downloads) are listed as read tools.
 */
export const affinePermissions: AppPermissionDefinition = {
  provider: "affine",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "get_session",
          name: "Get session",
          description: "Retrieve the current auth session",
          hostPattern: "*",
          pathPattern: "/api/auth/session",
          method: "GET",
        },
        {
          id: "read_workspace_content",
          name: "Read workspace content",
          description: "Download docs and blobs from workspaces",
          hostPattern: "*",
          pathPattern: "/api/workspaces/*",
          method: "GET",
        },
      ],
    },
    {
      category: "write",
      tools: [
        {
          id: "graphql",
          name: "GraphQL API",
          description:
            "Queries and mutations: workspaces, docs, users, and sharing (read + write)",
          hostPattern: "*",
          pathPattern: "/graphql",
          method: "POST",
        },
        {
          id: "upload_workspace_content",
          name: "Upload workspace content",
          description: "Upload docs and blobs to workspaces",
          hostPattern: "*",
          pathPattern: "/api/workspaces/*",
          methods: ["POST", "PUT"],
        },
      ],
    },
  ],
};
