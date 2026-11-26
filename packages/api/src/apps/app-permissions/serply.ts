import type { AppPermissionDefinition } from "./types";

// Serply REST API (api.serply.io, serply.io/docs). Every GET is a search
// vertical that returns public results for a query, so an unlisted GET
// (images, maps, jobs, and the other verticals) is a read too. The one
// endpoint that fetches arbitrary pages, /v1/request, is a POST.
export const serplyPermissions: AppPermissionDefinition = {
  provider: "serply",
  unlistedReads: "allow",
  groups: [
    {
      category: "read",
      tools: [
        {
          id: "search_web",
          name: "Web search",
          description: "Search Google web results",
          hostPattern: "api.serply.io",
          pathPattern: "/v1/search/*",
          aliasPatterns: ["/v1/search"],
          method: "GET",
        },
        {
          id: "search_news",
          name: "News search",
          description: "Search Google News results",
          hostPattern: "api.serply.io",
          pathPattern: "/v1/news/*",
          aliasPatterns: ["/v1/news"],
          method: "GET",
        },
        {
          id: "search_scholar",
          name: "Scholar search",
          description: "Search Google Scholar results",
          hostPattern: "api.serply.io",
          pathPattern: "/v1/scholar/*",
          aliasPatterns: ["/v1/scholar"],
          method: "GET",
        },
        {
          id: "search_videos",
          name: "Video search",
          description: "Search Google video results",
          hostPattern: "api.serply.io",
          pathPattern: "/v1/video/*",
          aliasPatterns: ["/v1/video"],
          method: "GET",
        },
      ],
    },
  ],
};
