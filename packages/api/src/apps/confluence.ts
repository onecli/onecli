import type { AppDefinition } from "./types";
import {
  buildAtlassianAuthUrl,
  exchangeAtlassianCode,
  atlassianConfigFields,
  atlassianEnvDefaults,
} from "./oauth/atlassian";

export const confluence: AppDefinition = {
  id: "confluence",
  setupGuideUrl: "https://onecli.sh/docs/integrations/confluence",
  name: "Confluence",
  apiDocsUrl: "https://developer.atlassian.com/cloud/confluence/rest/v2/intro/",
  icon: "/icons/confluence.svg",
  description: "Pages, spaces, and documentation in Confluence Cloud.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "read:me",
      "offline_access",
      "read:confluence-content.all",
      "write:confluence-content",
      "read:confluence-space.summary",
      "search:confluence",
      "read:page:confluence",
      "read:space:confluence",
      "write:page:confluence",
      "delete:page:confluence",
      "write:comment:confluence",
      "read:content:confluence",
    ],
    permissions: [
      {
        scope: "read:confluence-content.all",
        name: "Read content",
        description: "View pages, blogs, and comments",
        access: "read",
      },
      {
        scope: "write:confluence-content",
        name: "Manage content",
        description: "Create and edit pages, blogs, and comments",
        access: "write",
      },
      {
        scope: "read:confluence-space.summary",
        name: "Read spaces",
        description: "View space summaries and metadata",
        access: "read",
      },
      {
        // CQL search (/wiki/rest/api/search) accepts only this scope (or the
        // granular read:content-details:confluence). Without it Atlassian
        // answers 401 "scope does not match", while page reads still work.
        scope: "search:confluence",
        name: "Search content",
        description: "Find pages, blogs, and comments with CQL search",
        access: "read",
      },
      {
        scope: "read:page:confluence",
        name: "Read pages (v2)",
        description: "View pages and content via the v2 REST API",
        access: "read",
      },
      {
        scope: "write:page:confluence",
        name: "Write pages (v2)",
        description: "Create and update pages via the v2 REST API",
        access: "write",
      },
      // The v2 API takes granular scopes only, and its write scopes are split
      // per action: write:page:confluence doesn't cover deleting a page, and
      // no page scope covers posting a comment.
      {
        scope: "delete:page:confluence",
        name: "Delete pages (v2)",
        description: "Delete pages via the v2 REST API",
        access: "write",
      },
      {
        scope: "write:comment:confluence",
        name: "Write comments (v2)",
        description: "Add and edit comments via the v2 REST API",
        access: "write",
      },
      {
        scope: "read:me",
        name: "Profile",
        description: "Your Atlassian account name and avatar",
        access: "read",
      },
    ],
    buildAuthUrl: buildAtlassianAuthUrl,
    exchangeCode: exchangeAtlassianCode,
  },
  configurable: {
    fields: atlassianConfigFields,
    group: "atlassian",
    envDefaults: atlassianEnvDefaults,
  },
};
