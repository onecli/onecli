import type { AppDefinition } from "./types";
import {
  buildAtlassianAuthUrl,
  exchangeAtlassianCode,
  atlassianConfigFields,
  atlassianEnvDefaults,
} from "./atlassian-oauth";

export const confluence: AppDefinition = {
  id: "confluence",
  name: "Confluence",
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
      "read:page:confluence",
      "read:space:confluence",
      "write:page:confluence",
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
  available: true,
  configurable: {
    fields: atlassianConfigFields,
    envDefaults: atlassianEnvDefaults,
  },
};
