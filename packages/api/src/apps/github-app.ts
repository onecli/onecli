import { createSign } from "crypto";
import type { AppDefinition } from "./types";

export const normalizePem = (key: string): string => {
  let normalized = key.replace(/\\n/g, "\n").trim();

  if (
    !normalized.startsWith("-----BEGIN") ||
    !normalized.includes("-----END")
  ) {
    throw new Error("Invalid PEM format: missing BEGIN/END markers");
  }

  if (!normalized.includes("\n")) {
    normalized = normalized
      .replace(/(-----BEGIN [A-Z ]+-----)/g, "$1\n")
      .replace(/(-----END [A-Z ]+-----)/g, "\n$1");
    const match = normalized.match(
      /^(-----BEGIN [A-Z ]+-----)\n([\s\S]+)\n(-----END [A-Z ]+-----)$/,
    );
    if (match) {
      const body = match[2]!.replace(/\s+/g, "");
      const lines = body.match(/.{1,64}/g) ?? [body];
      normalized = `${match[1]}\n${lines.join("\n")}\n${match[3]}`;
    }
  }
  return normalized;
};

/** Signs an RS256 JWT for GitHub App API authentication (mirrors gateway's jsonwebtoken crate). */
export const signGitHubAppJwt = (appId: string, privateKey: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: appId,
    iat: now - 60,
    exp: now + 600,
  };

  const b64Header = Buffer.from(JSON.stringify(header)).toString("base64url");
  const b64Claims = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const unsigned = `${b64Header}.${b64Claims}`;

  const pem = normalizePem(privateKey);
  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  const signature = sign.sign(pem, "base64url");

  return `${unsigned}.${signature}`;
};

export const githubApp: AppDefinition = {
  id: "github-app",
  name: "GitHub App",
  icon: "/icons/github.svg",
  darkIcon: "/icons/github-light.svg",
  description:
    "Fine-grained, org-approved access to repositories and resources.",
  connectionMethod: {
    type: "oauth",
    permissions: [
      {
        scope: "contents",
        name: "Repository contents",
        description: "Code, commits, and branches",
        access: "write",
      },
      {
        scope: "pull_requests",
        name: "Pull requests",
        description: "Create, review, and merge PRs",
        access: "write",
      },
      {
        scope: "issues",
        name: "Issues",
        description: "Create and manage issues",
        access: "write",
      },
      {
        scope: "actions",
        name: "Actions",
        description: "View runs and trigger workflow dispatches",
        access: "write",
      },
      {
        scope: "checks",
        name: "Checks",
        description: "Read CI results, create check runs",
        access: "write",
      },
      {
        scope: "statuses",
        name: "Commit statuses",
        description: "Read and set status checks on commits",
        access: "write",
      },
      {
        scope: "discussions",
        name: "Discussions",
        description: "Read and participate in discussions",
        access: "write",
      },
      {
        scope: "repository_projects",
        name: "Projects",
        description: "Manage project boards",
        access: "write",
      },
      {
        scope: "metadata",
        name: "Metadata",
        description: "Repository metadata (always granted)",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, state }) => {
      const url = new URL(
        `https://github.com/apps/${appCredentials.appSlug}/installations/select_target`,
      );
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams }) => {
      const installationId = callbackParams.installation_id!;
      const jwt = signGitHubAppJwt(
        appCredentials.appId!,
        appCredentials.privateKey!,
      );

      const tokenRes = await fetch(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

      if (!tokenRes.ok) {
        const body = (await tokenRes.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(
          body.message ??
            `GitHub App token exchange failed: ${tokenRes.status}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        token?: string;
        expires_at?: string;
        permissions?: Record<string, string>;
      };

      if (!tokenData.token) {
        throw new Error("Failed to obtain installation access token");
      }

      if (!tokenData.expires_at) {
        throw new Error(
          "GitHub API did not return expires_at for installation token",
        );
      }
      const expiresAt = Math.floor(
        new Date(tokenData.expires_at).getTime() / 1000,
      );

      const installRes = await fetch(
        `https://api.github.com/app/installations/${installationId}`,
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

      let accountLogin: string | undefined;
      let accountType: string | undefined;
      let accountAvatarUrl: string | undefined;

      let repositorySelection: string | undefined;

      if (installRes.ok) {
        const install = (await installRes.json()) as {
          account?: { login?: string; type?: string; avatar_url?: string };
          repository_selection?: string;
        };
        accountLogin = install.account?.login;
        accountType = install.account?.type;
        accountAvatarUrl = install.account?.avatar_url;
        repositorySelection = install.repository_selection;
      } else {
        console.warn(
          `GitHub App installation metadata fetch failed: ${installRes.status}`,
        );
      }

      const reposRes = await fetch(
        "https://api.github.com/installation/repositories?per_page=100",
        {
          headers: {
            Authorization: `token ${tokenData.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

      let repos: string[] = [];
      if (reposRes.ok) {
        const reposData = (await reposRes.json()) as {
          repositories?: { full_name?: string }[];
          total_count?: number;
        };
        repos =
          reposData.repositories
            ?.map((r) => r.full_name)
            .filter((n): n is string => !!n) ?? [];
        if (reposData.total_count && reposData.total_count > repos.length) {
          console.warn(
            `GitHub App installation has ${reposData.total_count} repos, showing first ${repos.length}`,
          );
        }
      } else {
        console.warn(
          `GitHub App repositories fetch failed: ${reposRes.status}`,
        );
      }

      return {
        credentials: {
          type: "github_app",
          installation_id: installationId,
          app_id: appCredentials.appId!,
          private_key: appCredentials.privateKey!,
          access_token: tokenData.token,
          expires_at: expiresAt,
        },
        scopes: Object.entries(tokenData.permissions ?? {}).map(
          ([k, v]) => `${k}:${v}`,
        ),
        metadata: {
          username: accountLogin,
          accountType,
          avatarUrl: accountAvatarUrl,
          installationId,
          manageUrl: installationId
            ? accountType === "Organization" && accountLogin
              ? `https://github.com/organizations/${accountLogin}/settings/installations/${installationId}`
              : `https://github.com/settings/installations/${installationId}`
            : undefined,
          repositorySelection,
          repos,
          tags:
            repositorySelection === "all"
              ? ["All repositories"]
              : repos.map((r) => r.split("/").pop() ?? r),
          permissions: tokenData.permissions,
        },
      };
    },
  },
  available: true,
  configurable: {
    fields: [
      {
        name: "appId",
        label: "App ID",
        description: "Numeric ID from your GitHub App settings",
        placeholder: "123456",
      },
      {
        name: "appSlug",
        label: "App Slug",
        description: "URL-friendly name from your GitHub App settings",
        placeholder: "my-org-onecli",
      },
      {
        name: "privateKey",
        label: "Private Key",
        placeholder: "-----BEGIN RSA PRIVATE KEY-----...",
        secret: true,
      },
    ],
    envDefaults: {
      appId: "GITHUB_APP_ID",
      appSlug: "GITHUB_APP_SLUG",
      privateKey: "GITHUB_APP_PRIVATE_KEY",
    },
  },
};
