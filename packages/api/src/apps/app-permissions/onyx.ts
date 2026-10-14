import type { AppPermissionDefinition, AppTool } from "./types";

// Onyx Cloud API (docs.onyx.app/developers), paths from the OpenAPI the
// server publishes at cloud.onyx.app/api/openapi.json. The API answers under
// `/api/` on cloud.onyx.app (the same host serves the web app, which the
// gateway leaves alone), and the hosted MCP server under `/mcp`.
//
// Single-item paths end in `*/`: one segment exactly, never deeper.
//
// Search is a POST with the query in the body, so it is a READ. Chatting is
// a WRITE: every message creates a chat session or a message in one, and it
// spends the tenant's LLM budget. The MCP server is its own tool, never a
// side effect of a REST grant.
const HOST = "cloud.onyx.app";

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
  hostPattern: HOST,
  pathPattern,
  ...(aliasPatterns ? { aliasPatterns } : {}),
  ...(methods.length === 1 ? { method: methods[0] } : { methods }),
});

export const onyxPermissions: AppPermissionDefinition = {
  provider: "onyx",
  groups: [
    {
      category: "read",
      tools: [
        tool(
          "get_me",
          "Read key identity",
          "See who the key belongs to and what it can do",
          "/api/me",
          ["GET"],
          ["/api/me/permissions"],
        ),
        tool(
          "search",
          "Search documents",
          "Search the company knowledge indexed in Onyx",
          "/api/search",
          ["POST"],
          [
            "/api/search/send-search-message",
            "/api/search/search-flow-classification",
          ],
        ),
        tool(
          "search_history",
          "Read search history",
          "Read past searches",
          "/api/search/search-history",
          ["GET"],
        ),
        tool(
          "list_chat_sessions",
          "List chat sessions",
          "List chat sessions, read one, and search past chats",
          "/api/chat/get-user-chat-sessions",
          ["GET"],
          ["/api/chat/get-chat-session/*/", "/api/chat/search"],
        ),
        tool(
          "list_agents",
          "List agents",
          "List Onyx agents (personas) and read one",
          "/api/persona",
          ["GET"],
          ["/api/persona/*/", "/api/agents"],
        ),
        tool(
          "list_document_sets",
          "List document sets",
          "List document sets",
          "/api/manage/document-set",
          ["GET"],
          ["/api/manage/document-set-public"],
        ),
        tool(
          "list_connectors",
          "List connectors",
          "List connectors and their indexing status",
          "/api/manage/admin/connector",
          ["GET"],
          [
            "/api/manage/admin/connector/status",
            "/api/manage/admin/connector/failed-indexing-status",
          ],
        ),
        tool(
          "connector_indexing_status",
          "Read indexing status",
          "Read detailed indexing status for connectors",
          "/api/manage/admin/connector/indexing-status",
          ["POST"],
        ),
        tool(
          "list_ingested_documents",
          "List ingested documents",
          "List documents sent through the ingestion API",
          "/api/onyx-api/ingestion",
          ["GET"],
          ["/api/onyx-api/connector-docs/*/"],
        ),
        tool(
          "list_projects",
          "List projects",
          "List projects and read one",
          "/api/user/projects",
          ["GET"],
          ["/api/user/projects/*/", "/api/user/projects/*/details"],
        ),
      ],
    },
    {
      category: "write",
      tools: [
        tool(
          "chat",
          "Chat with Onyx",
          "Start a chat session and send messages to an Onyx agent",
          "/api/chat/send-chat-message",
          ["POST"],
          ["/api/chat/create-chat-session"],
        ),
        tool(
          "delete_chat_session",
          "Delete chat session",
          "Delete a chat session",
          "/api/chat/delete-chat-session/*/",
          ["DELETE"],
        ),
        tool(
          "ingest_documents",
          "Ingest documents",
          "Add or update documents through the ingestion API",
          "/api/onyx-api/ingestion",
          ["POST"],
        ),
        tool(
          "delete_ingested_document",
          "Delete ingested document",
          "Delete a document sent through the ingestion API",
          "/api/onyx-api/ingestion/*/",
          ["DELETE"],
        ),
        tool(
          "manage_connectors",
          "Manage connectors",
          "Create connectors, or run one now",
          "/api/manage/admin/connector",
          ["POST"],
          ["/api/manage/admin/connector/run-once"],
        ),
        tool(
          "update_connector",
          "Update or delete connector",
          "Change or delete one connector",
          "/api/manage/admin/connector/*/",
          ["PATCH", "DELETE"],
        ),
        tool(
          "create_agent",
          "Create agent",
          "Create an Onyx agent (persona)",
          "/api/persona",
          ["POST"],
        ),
        tool(
          "update_agent",
          "Update or delete agent",
          "Change or delete one Onyx agent",
          "/api/persona/*/",
          ["PATCH", "DELETE"],
        ),
        // The MCP transport uses POST for calls, GET for the event stream,
        // and DELETE to end a session; clients may drop the trailing slash.
        {
          id: "mcp_access",
          name: "MCP server",
          description:
            "Search and chat through the hosted Onyx MCP server at cloud.onyx.app/mcp",
          hostPattern: HOST,
          pathPattern: "/mcp",
          aliasPatterns: ["/mcp/*"],
        },
      ],
    },
  ],
};
