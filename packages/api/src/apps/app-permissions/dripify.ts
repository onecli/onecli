import type { AppPermissionDefinition, AppTool } from "./types";

// Dripify Open API (api.dripify.com), every operation from the OpenAPI the
// reference page embeds. One dedicated API host, every path under
// /v1/open-api/. The hosted MCP server takes the same key on the web app's
// host (app.dripify.com/api/v1/mcp) and is its own tool.
//
// Single-item paths end in `*/`: one segment exactly, never deeper.
// `/leads/*` would also match `/leads/{id}/activity` and `/leads/{id}/messages`,
// so "Get lead" would reach sending a message.
//
// `POST /leads/search` is a READ (the lookup criteria travel in the body).
// Every other POST/PUT/DELETE is a write. Sending a message, and adding leads
// to an active campaign, reach real people on LinkedIn under the user's name.
const API_HOST = "api.dripify.com";
const MCP_HOST = "app.dripify.com";
const P = "/v1/open-api";

const tool = (
  id: string,
  name: string,
  description: string,
  pathPattern: string,
  methods: string[],
  aliasPatterns?: string[],
): AppTool => ({
  id,
  name,
  description,
  hostPattern: API_HOST,
  pathPattern,
  ...(aliasPatterns ? { aliasPatterns } : {}),
  ...(methods.length === 1 ? { method: methods[0] } : { methods }),
});

export const dripifyPermissions: AppPermissionDefinition = {
  provider: "dripify",
  groups: [
    {
      category: "read",
      tools: [
        tool(
          "list_campaigns",
          "List campaigns",
          "List campaigns, their lead lists, and their statistics",
          `${P}/campaigns`,
          ["GET"],
          [`${P}/campaigns/*/lead-lists`, `${P}/campaigns/*/statistics`],
        ),
        tool(
          "list_leads",
          "List leads",
          "List leads, filtered by campaign, list, or status",
          `${P}/leads`,
          ["GET"],
        ),
        tool(
          "search_leads",
          "Look up a lead",
          "Find a lead by email or LinkedIn profile URL",
          `${P}/leads/search`,
          ["POST"],
        ),
        tool(
          "get_lead",
          "Get lead",
          "Read one lead's details and activity log",
          `${P}/leads/*/`,
          ["GET"],
          [`${P}/leads/*/activity`],
        ),
        tool(
          "read_conversations",
          "Read conversations",
          "Read a lead's LinkedIn conversation and its messages",
          `${P}/leads/*/conversation`,
          ["GET"],
          [`${P}/conversations/*/messages`],
        ),
        tool(
          "list_fields_and_tags",
          "List custom fields and tags",
          "List custom lead field definitions and tags",
          `${P}/custom-lead-fields`,
          ["GET"],
          [`${P}/tags`],
        ),
        tool(
          "list_teams",
          "List teams",
          "List teams and their members",
          `${P}/teams`,
          ["GET"],
          [`${P}/teams/*/members`],
        ),
      ],
    },
    {
      category: "write",
      tools: [
        tool(
          "send_message",
          "Send a LinkedIn message",
          "Send a message in a lead's existing LinkedIn conversation",
          `${P}/leads/*/messages`,
          ["POST"],
        ),
        tool(
          "add_leads_to_campaign",
          "Add leads to a campaign",
          "Upload leads into a campaign, or append them to a lead list (an active campaign starts reaching out to them)",
          `${P}/campaigns/*/leads`,
          ["POST"],
          [`${P}/lead-lists/*/leads`],
        ),
        tool(
          "tag_leads",
          "Tag leads",
          "Apply or remove tags on a batch of leads",
          `${P}/leads/tags`,
          ["PUT", "DELETE"],
        ),
        tool("create_tag", "Create tag", "Create a new tag", `${P}/tags`, [
          "POST",
        ]),
        tool(
          "set_custom_field",
          "Set custom field",
          "Set or clear a custom field value on a lead",
          `${P}/leads/*/custom-fields/*/`,
          ["PUT", "DELETE"],
        ),
        // A write: the server can upload leads into a campaign. Any method:
        // MCP's HTTP transport uses POST for calls, GET for the event stream,
        // and DELETE to end a session; clients may drop the trailing slash.
        {
          id: "mcp_access",
          name: "MCP server",
          description:
            "Read campaigns and leads, and upload leads into a campaign, through the hosted Dripify MCP server",
          hostPattern: MCP_HOST,
          pathPattern: "/api/v1/mcp",
          aliasPatterns: ["/api/v1/mcp/*"],
        },
      ],
    },
  ],
};
