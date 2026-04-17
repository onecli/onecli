import type { AppDefinition } from "./types";
import { buildGithubAuthUrl, exchangeGithubCode } from "./github-oauth";

const cfgFromConfig = (config: Record<string, string>) => {
  const baseUrl = config.baseUrl;
  if (!baseUrl) {
    throw new Error(
      "GitHub Enterprise connection is missing baseUrl in config",
    );
  }
  return { baseUrl, apiBase: `${baseUrl}/api/v3` };
};

export const githubEnterprise: AppDefinition = {
  id: "github-enterprise",
  name: "GitHub Enterprise",
  icon: "/icons/github-enterprise.svg",
  darkIcon: "/icons/github-enterprise.svg",
  description:
    "Self-hosted GitHub Enterprise Server (GHES). Connect to your organization's own instance.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "repo",
      "user",
      "gist",
      "notifications",
      "project",
      "codespace",
      "workflow",
    ],
    permissions: [
      {
        scope: "repo",
        name: "Repositories",
        description: "Code, issues, and pull requests",
        access: "write",
      },
      {
        scope: "user",
        name: "Profile",
        description: "Email, name, and avatar",
        access: "read",
      },
      {
        scope: "gist",
        name: "Gists",
        description: "Create and manage gists",
        access: "write",
      },
      {
        scope: "notifications",
        name: "Notifications",
        description: "View notifications",
        access: "read",
      },
      {
        scope: "project",
        name: "Projects",
        description: "Manage project boards",
        access: "write",
      },
      {
        scope: "codespace",
        name: "Codespaces",
        description: "Create and manage",
        access: "write",
      },
      {
        scope: "workflow",
        name: "Actions",
        description: "Update workflow files",
        access: "write",
      },
    ],
    buildAuthUrl: (params) =>
      buildGithubAuthUrl(cfgFromConfig(params.config), params),
    exchangeCode: async (params) => {
      const cfg = cfgFromConfig(params.config);
      const result = await exchangeGithubCode(cfg, params);
      return {
        ...result,
        metadata: { ...(result.metadata ?? {}), baseUrl: cfg.baseUrl },
      };
    },
  },
  available: true,
  configurable: {
    fields: [
      {
        name: "baseUrl",
        label: "Enterprise URL",
        description:
          "The root URL of your GitHub Enterprise Server (e.g. https://github.ibm.com).",
        placeholder: "https://github.ibm.com",
        required: true,
      },
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "Iv1.abc123...",
        required: true,
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "secret_...",
        secret: true,
        required: true,
      },
    ],
    envDefaults: {
      baseUrl: "GITHUB_ENTERPRISE_BASE_URL",
      clientId: "GITHUB_ENTERPRISE_CLIENT_ID",
      clientSecret: "GITHUB_ENTERPRISE_CLIENT_SECRET",
    },
  },
};
