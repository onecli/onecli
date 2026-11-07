import { createSign } from "crypto";
import { pkceChallenge, pkceVerifier } from "./oauth/pkce";
import { IS_CLOUD } from "../lib/env";
import type { OAuthStatePayload } from "../lib/oauth-state";
import type {
  AppDefinition,
  OAuthContinuation,
  OAuthExchangeCodeParams,
} from "./types";

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

export const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

/** Cap on repos read from one installation (10 pages of 100). */
const MAX_INSTALLATION_REPOS = 1000;

/** A refused installation call, with GitHub's status (404 = installation gone). */
export class GitHubInstallationError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubInstallationError";
    this.status = status;
  }
}

/**
 * Mint an installation access token. With `repositories` (owner/name or bare
 * names, all on the installation's account) GitHub narrows the token to just
 * those repos — the same request the gateway makes. An EMPTY list is refused:
 * GitHub would read an absent field as "every repo". With `permissions` the
 * token carries only those (never more than the app was granted); without,
 * it carries every permission the app has.
 */
export const mintGitHubInstallationToken = async (args: {
  appId: string;
  privateKey: string;
  installationId: string;
  repositories?: string[];
  permissions?: Record<string, "read" | "write">;
}): Promise<{
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
}> => {
  if (args.repositories && args.repositories.length === 0) {
    throw new Error("Refusing to mint a token for an empty repository list");
  }
  const body = {
    ...(args.repositories && {
      repositories: args.repositories.map((r) => r.split("/").pop() ?? r),
    }),
    ...(args.permissions && { permissions: args.permissions }),
  };
  const jwt = signGitHubAppJwt(args.appId, args.privateKey);
  const res = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(args.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...GITHUB_API_HEADERS,
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GitHubInstallationError(
      body.message ?? `GitHub App token exchange failed: ${res.status}`,
      res.status,
    );
  }
  const data = (await res.json()) as {
    token?: string;
    expires_at?: string;
    permissions?: Record<string, string>;
  };
  if (!data.token || !data.expires_at) {
    throw new Error("Failed to obtain installation access token");
  }
  return {
    token: data.token,
    expiresAt: Math.floor(new Date(data.expires_at).getTime() / 1000),
    permissions: data.permissions ?? {},
  };
};

/** Every repo an installation token can reach (`owner/name`), paged. */
export const listGitHubInstallationRepos = async (
  token: string,
): Promise<{ repos: string[]; truncated: boolean }> => {
  const repos: string[] = [];
  let total = 0;
  for (let page = 1; repos.length < MAX_INSTALLATION_REPOS; page++) {
    const res = await fetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      { headers: { ...GITHUB_API_HEADERS, Authorization: `token ${token}` } },
    );
    if (!res.ok) {
      throw new Error(`GitHub App repositories fetch failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      repositories?: { full_name?: string }[];
      total_count?: number;
    };
    total = data.total_count ?? 0;
    const batch =
      data.repositories
        ?.map((r) => r.full_name)
        .filter((n): n is string => !!n) ?? [];
    repos.push(...batch);
    if (batch.length < 100 || repos.length >= total) break;
  }
  return { repos, truncated: total > repos.length };
};

/** GitHub installation ids are numeric; anything else is never sent on. */
const INSTALLATION_ID = /^\d+$/;

/** Pages of `GET /user/installations` read (100 each) before refusing. */
const MAX_INSTALLATION_PAGES = 10;

/** Per-call bound on the ownership proof's GitHub requests. */
const GITHUB_TIMEOUT_MS = 5000;

/** Signed-state key carrying the installation id between the two legs. */
const PENDING_INSTALLATION = "githubInstallationId";

const NOT_CONFIRMED =
  "GitHub did not confirm your access to this installation. Try connecting again.";

const PLATFORM_APP_UNAVAILABLE =
  "Connecting the GitHub App isn't available right now. Please contact support.";

/**
 * One GitHub call of the ownership proof. A timeout or network failure
 * becomes the fixed refusal: the callback shows thrown messages to the user,
 * and none of GitHub's (or the runtime's) text should reach them.
 */
const githubFetch = (url: string, init: RequestInit): Promise<Response> =>
  fetch(url, {
    ...init,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  }).catch(() => {
    throw new Error(NOT_CONFIRMED);
  });

/**
 * The platform GitHub App's OAuth client (GITHUB_APP_CLIENT_ID / _SECRET),
 * used ONLY to prove which installations the connecting user can access. It
 * applies to the platform app (`GITHUB_APP_ID`) alone: one key there mints
 * tokens for every customer's installation. A customer's own (BYOC) app only
 * reaches that customer's installations, so it skips the proof.
 *
 * Cloud always carries the client. Should it ever be missing there, the
 * platform app's callback refuses rather than mint from an unproven
 * `installation_id` (see `resolveInstallation`). A self-host without it
 * keeps the direct mint: its platform app is the operator's own.
 */
const platformUserAuth = (appId: string) => {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  const platformAppId = process.env.GITHUB_APP_ID;
  if (!clientId || !clientSecret || !platformAppId) return null;
  return appId === platformAppId ? { clientId, clientSecret } : null;
};

type PlatformUserAuth = NonNullable<ReturnType<typeof platformUserAuth>>;

/**
 * Whether connecting through app `appId` proves the user can access the
 * installation it names. A customer's own (BYOC) app reaches only that
 * customer's installations, so yes. The platform app (one key for every
 * customer) proves it only through its OAuth client: without
 * GITHUB_APP_CLIENT_ID/_SECRET a setup redirect's `installation_id` is
 * unproven, and anything that hands out access by it must refuse.
 */
export const githubInstallsAreProven = (appId: string | undefined): boolean =>
  !!appId &&
  (appId !== process.env.GITHUB_APP_ID || platformUserAuth(appId) !== null);

/**
 * Both legs complete only in the browser the state was issued to: it must
 * carry the `oauth_state` cookie (set by `/authorize`, then by leg 1), and a
 * state in the query must equal it (the route falls back to the cookie when
 * the query has none). GitHub skips consent for a user who already authorized
 * the app, so without this a crafted link carrying an attacker's own state
 * could walk a signed-in victim through both legs in one click and land the
 * victim's installation in the attacker's workspace.
 */
const sameBrowserState = ({
  callbackParams,
  state,
  stateCookie,
}: OAuthExchangeCodeParams): { raw: string; payload: OAuthStatePayload } => {
  const returned = callbackParams.state ?? stateCookie;
  if (!state || !stateCookie || returned !== stateCookie) {
    throw new Error(NOT_CONFIRMED);
  }
  return { raw: stateCookie, payload: state };
};

/**
 * The installation a callback is about. On the second leg of the ownership
 * proof the id comes from the signed state, never the query again. Only a
 * numeric id is accepted: it is pasted into api.github.com paths. On cloud,
 * the platform app without its OAuth client is refused here, before either
 * leg can mint (fail closed).
 */
const resolveInstallation = ({
  appCredentials,
  callbackParams,
  state,
}: OAuthExchangeCodeParams) => {
  const pending = state?.[PENDING_INSTALLATION];
  const secondLeg = typeof pending === "string";
  const installationId = secondLeg ? pending : callbackParams.installation_id;
  if (!installationId || !INSTALLATION_ID.test(installationId)) {
    throw new Error("Invalid GitHub installation");
  }
  const appId = appCredentials.appId!;
  const auth = platformUserAuth(appId);
  if (!auth && IS_CLOUD && appId === process.env.GITHUB_APP_ID) {
    throw new Error(PLATFORM_APP_UNAVAILABLE);
  }
  return { installationId, secondLeg, auth };
};

/**
 * Leg 1 of the ownership proof. The setup redirect's `installation_id` is a
 * query parameter anyone can type (GitHub's setup-URL docs say never to trust
 * it), and GitHub sends no user `code` when an existing installation is
 * configured. So instead of trusting either, send the browser through GitHub's
 * web flow: the id rides a re-signed state (never the query again), the flow
 * uses PKCE and the same callback as its redirect_uri, and the new state also
 * becomes this browser's `oauth_state` cookie so leg 2 only completes in the
 * browser that started it. A user who already authorized the app is sent
 * straight back by GitHub with no prompt.
 */
const startOwnershipProof = async (
  auth: PlatformUserAuth,
  installationId: string,
  params: OAuthExchangeCodeParams,
): Promise<OAuthContinuation> => {
  const { payload } = sameBrowserState(params);
  // Server-only path: node crypto (via oauth-state) stays out of the
  // client-reachable registry graph.
  const { generateNonce, signOAuthState } = await import("../lib/oauth-state");
  const next = signOAuthState({
    ...payload,
    nonce: generateNonce(),
    [PENDING_INSTALLATION]: installationId,
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", auth.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", next);
  url.searchParams.set(
    "code_challenge",
    await pkceChallenge(await pkceVerifier(next)),
  );
  url.searchParams.set("code_challenge_method", "S256");
  return { continueAt: url.toString(), state: next };
};

/** `GET /user/installations`, paged, looking for one id. */
const userCanAccessInstallation = async (
  userToken: string,
  installationId: string,
): Promise<boolean> => {
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const res = await githubFetch(
      `https://api.github.com/user/installations?per_page=100&page=${page}`,
      {
        headers: {
          ...GITHUB_API_HEADERS,
          Authorization: `Bearer ${userToken}`,
        },
      },
    );
    if (!res.ok) throw new Error(NOT_CONFIRMED);
    // Never surface a parser message: it can quote the response body.
    const data = (await res.json().catch(() => null)) as {
      installations?: { id?: number }[];
    } | null;
    if (!data) throw new Error(NOT_CONFIRMED);
    const batch = data.installations ?? [];
    if (batch.some((i) => String(i.id) === installationId)) return true;
    if (batch.length < 100) return false;
  }
  return false;
};

/**
 * Leg 2: GitHub returned to the callback with a user `code`. The installation
 * is the one leg 1 signed into the state, never the query. Exchange the code
 * (PKCE + redirect_uri), accept only if GitHub lists the installation for this
 * user, and revoke the user token either way: it proved access and is never
 * stored.
 */
const finishOwnershipProof = async (
  auth: PlatformUserAuth,
  installationId: string,
  params: OAuthExchangeCodeParams,
): Promise<void> => {
  const { raw } = sameBrowserState(params);
  const { callbackParams, redirectUri } = params;
  if (callbackParams.error || !callbackParams.code) {
    throw new Error(NOT_CONFIRMED);
  }

  const tokenRes = await githubFetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        code: callbackParams.code,
        redirect_uri: redirectUri,
        code_verifier: await pkceVerifier(raw),
      }),
    },
  );
  const tokenData = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
  };
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(NOT_CONFIRMED);
  }
  const userToken = tokenData.access_token;

  let allowed: boolean;
  try {
    allowed = await userCanAccessInstallation(userToken, installationId);
  } finally {
    // Best effort: the token is short-lived and never stored either way.
    await githubFetch(
      `https://api.github.com/applications/${encodeURIComponent(auth.clientId)}/token`,
      {
        method: "DELETE",
        headers: {
          ...GITHUB_API_HEADERS,
          Authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_token: userToken }),
      },
    ).catch(() => {});
  }
  if (!allowed) {
    throw new Error("You don't have access to this GitHub installation.");
  }
};

export const githubApp: AppDefinition = {
  id: "github-app",
  setupGuideUrl: "https://onecli.sh/docs/integrations/github-app",
  name: "GitHub App",
  icon: "/icons/github.svg",
  apiDocsUrl: "https://docs.github.com/en/rest",
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
    // GitHub sends its setup redirect after "Configure" (an installation that
    // already exists) with no `state`; the one callback that may fall back to
    // this browser's `oauth_state` cookie.
    acceptsCookieOnlyState: (params) =>
      typeof params.installation_id === "string" &&
      typeof params.setup_action === "string",
    // Leg 1 (platform app only): every setup redirect, install or update,
    // detours through GitHub's web flow before anything is minted.
    continueCallback: async (params) => {
      const { installationId, auth, secondLeg } = resolveInstallation(params);
      return auth && !secondLeg
        ? startOwnershipProof(auth, installationId, params)
        : null;
    },
    exchangeCode: async (params) => {
      const { appCredentials } = params;
      const { installationId, auth, secondLeg } = resolveInstallation(params);
      // Platform app: only leg 2, for the id leg 1 signed, after proving the
      // user can access it. Nothing mints straight from a setup redirect.
      if (auth) {
        if (!secondLeg) throw new Error(NOT_CONFIRMED);
        await finishOwnershipProof(auth, installationId, params);
      }
      const appId = appCredentials.appId!;
      const privateKey = appCredentials.privateKey!;
      const minted = await mintGitHubInstallationToken({
        appId,
        privateKey,
        installationId,
      });

      const installRes = await fetch(
        `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
        {
          headers: {
            ...GITHUB_API_HEADERS,
            Authorization: `Bearer ${signGitHubAppJwt(appId, privateKey)}`,
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

      // The repo list feeds the resource picker and its server-side shape
      // check. A failed read leaves it empty rather than failing the connect.
      let repos: string[] = [];
      try {
        const listed = await listGitHubInstallationRepos(minted.token);
        repos = listed.repos;
        if (listed.truncated) {
          console.warn(
            `GitHub App installation has more repos than the first ${repos.length} listed`,
          );
        }
      } catch (err) {
        console.warn(
          err instanceof Error
            ? err.message
            : "GitHub App repositories fetch failed",
        );
      }

      return {
        credentials: {
          type: "github_app",
          installation_id: installationId,
          app_id: appId,
          private_key: privateKey,
          access_token: minted.token,
          expires_at: minted.expiresAt,
        },
        scopes: Object.entries(minted.permissions).map(([k, v]) => `${k}:${v}`),
        metadata: {
          username: accountLogin,
          accountType,
          avatarUrl: accountAvatarUrl,
          installationId,
          manageUrl:
            accountType === "Organization" && accountLogin
              ? `https://github.com/organizations/${accountLogin}/settings/installations/${installationId}`
              : `https://github.com/settings/installations/${installationId}`,
          repositorySelection,
          repos,
          tags:
            repositorySelection === "all"
              ? ["All repositories"]
              : repos.map((r) => r.split("/").pop() ?? r),
          permissions: minted.permissions,
        },
      };
    },
  },
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
