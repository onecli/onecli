import type { AppDefinition } from "./types";
import {
  buildAtlassianAuthUrl,
  exchangeAtlassianCode,
  atlassianConfigFields,
  atlassianEnvDefaults,
} from "./atlassian-oauth";

export const jira: AppDefinition = {
  id: "jira",
  name: "Jira",
  icon: "/icons/jira.svg",
  description: "Projects, issues, and workflows in Jira Cloud.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "read:me",
      "offline_access",
      "read:jira-work",
      "write:jira-work",
      "read:jira-user",
    ],
    permissions: [
      {
        scope: "read:jira-work",
        name: "Read issues",
        description: "View projects, issues, and search results",
        access: "read",
      },
      {
        scope: "write:jira-work",
        name: "Manage issues",
        description: "Create and edit issues, comments, and worklogs",
        access: "write",
      },
      {
        scope: "read:jira-user",
        name: "User profiles",
        description: "View user profiles and email addresses",
        access: "read",
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
