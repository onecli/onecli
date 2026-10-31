import type { AppPermissionDefinition, AppTool } from "./types";

// Tavily REST API (api.tavily.com), every operation in its published OpenAPI
// (docs.tavily.com/documentation/api-reference/openapi.json), plus the hosted
// MCP server on its own host. Every endpoint takes the same Bearer API key
// except POST /org-usage, which takes the organization owner's personal key.
//
// Research is asynchronous: POST /research starts a task and the agent polls
// GET /research/{request_id} for the report, so the poll is its own read.
// POST /logs and POST /org-usage carry their filters in the body and are
// reads. The one write is POST /feedback, which stores a rating with Tavily.
const API_HOST = "api.tavily.com";

const tool = (
  id: string,
  name: string,
  description: string,
  pathPattern: string,
  method: string,
): AppTool => ({
  id,
  name,
  description,
  hostPattern: API_HOST,
  pathPattern,
  method,
});

export const tavilyPermissions: AppPermissionDefinition = {
  provider: "tavily",
  unlistedReads: "allow",
  groups: [
    {
      category: "read",
      tools: [
        tool(
          "search",
          "Search",
          "Search the web and get ranked results for a query",
          "/search",
          "POST",
        ),
        tool(
          "extract",
          "Extract",
          "Extract the content of one or more web pages",
          "/extract",
          "POST",
        ),
        tool(
          "crawl",
          "Crawl",
          "Crawl a website from a starting URL and extract its pages",
          "/crawl",
          "POST",
        ),
        tool(
          "map",
          "Map",
          "List a website's URLs from a starting URL",
          "/map",
          "POST",
        ),
        tool(
          "research",
          "Research",
          "Start a research task that produces a cited report",
          "/research",
          "POST",
        ),
        // One segment exactly: the task's request_id.
        tool(
          "get_research",
          "Get research results",
          "Check a research task's status and read its report",
          "/research/*/",
          "GET",
        ),
        tool(
          "usage",
          "View usage",
          "Read the API key's and account's credit usage and limits",
          "/usage",
          "GET",
        ),
        tool(
          "logs",
          "Read usage logs",
          "Read per-request usage logs for the account's API keys",
          "/logs",
          "POST",
        ),
        tool(
          "org_usage",
          "View organization usage",
          "Read credit usage for every API key in an organization",
          "/org-usage",
          "POST",
        ),
        // The MCP server's tools are all reads (search, extract, crawl, map,
        // research). Its HTTP transport uses POST for calls, and clients may
        // drop the trailing slash. Only /mcp: the same host serves Tavily's
        // OAuth endpoints, which agents never call.
        {
          id: "mcp_access",
          name: "MCP server",
          description:
            "Search, extract, crawl, map, and research through the hosted Tavily MCP server",
          hostPattern: "mcp.tavily.com",
          pathPattern: "/mcp",
          aliasPatterns: ["/mcp/*"],
        },
      ],
    },
    {
      category: "write",
      tools: [
        tool(
          "feedback",
          "Submit feedback",
          "Rate how relevant and useful a search or session's results were",
          "/feedback",
          "POST",
        ),
      ],
    },
  ],
};
