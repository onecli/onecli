import type { AppDefinition, OAuthPermission } from "./types";
import { pkceChallenge, pkceVerifier } from "./oauth/pkce";

// Attio issues tokens at two levels (docs.attio.com/rest-api/guides/authentication):
// `workspace` acts for the whole workspace and only a workspace admin can grant
// it; `user` acts as one member, limited to their own Attio permissions, and any
// member can grant it once an admin has installed the app. Omitting
// `token_level` means workspace, so that stays the default and the flow every
// existing connection was made with. User-level tokens require PKCE.

// Attio's scopes are configured on the app at build.attio.com, not requested
// per authorize, so this list mirrors what the app asks for. A token can hold
// fewer (a user-level one gets only the user scopes the installing admin
// approved): the exchange stores what `/v2/self` reports, and falls back to
// this list only when that lookup fails.
const permissions: OAuthPermission[] = [
  {
    scope: "record_permission:read-write",
    name: "Records",
    description: "Contacts, companies, and deals",
    access: "write",
  },
  {
    scope: "object_configuration:read-write",
    name: "Object Configuration",
    description: "Custom objects and attributes",
    access: "write",
  },
  {
    scope: "list_entry:read-write",
    name: "List Entries",
    description: "Entries in lists",
    access: "write",
  },
  {
    scope: "list_configuration:read-write",
    name: "List Configuration",
    description: "Lists and their columns",
    access: "write",
  },
  {
    scope: "note:read-write",
    name: "Notes",
    description: "Notes on records",
    access: "write",
  },
  {
    scope: "task:read-write",
    name: "Tasks",
    description: "Tasks and assignments",
    access: "write",
  },
  {
    scope: "comment:read-write",
    name: "Comments",
    description: "Threads and comments",
    access: "write",
  },
  {
    scope: "file:read-write",
    name: "Files",
    description: "Upload and view files",
    access: "write",
  },
  {
    scope: "webhook:read-write",
    name: "Webhooks",
    description: "Manage webhooks",
    access: "write",
  },
  {
    scope: "user_management:read",
    name: "User Management",
    description: "View workspace members",
    access: "read",
  },
  {
    scope: "meeting:read-write",
    name: "Meetings",
    description: "View and manage meetings",
    access: "write",
  },
  {
    scope: "call_recording:read",
    name: "Call Recordings",
    description: "Transcripts and speakers",
    access: "read",
  },
];

/** The `/v2/self` fields this definition reads. Every member but `active` is
 *  optional (docs.attio.com/rest-api/endpoint-reference/meta/identify). */
interface AttioSelf {
  token_level?: string;
  scope?: string;
  workspace_id?: string;
  workspace_name?: string;
  workspace_slug?: string;
  workspace_logo_url?: string;
  authorized_by_workspace_member_id?: string;
}

export const attio: AppDefinition = {
  id: "attio",
  setupGuideUrl: "https://onecli.sh/docs/integrations/attio",
  name: "Attio",
  icon: "/icons/attio.svg",
  apiDocsUrl: "https://docs.attio.com/rest-api/overview",
  darkIcon: "/icons/attio-light.svg",
  description: "Contacts, companies, deals, lists, notes, and tasks.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [],
    permissions,
    accessLevels: {
      label: "Access level",
      defaultValue: "workspace",
      options: [
        {
          value: "workspace",
          label: "Workspace access",
          description: "Acts for the whole workspace. Needs an Attio admin.",
        },
        {
          value: "user",
          label: "Personal access",
          description: "Acts as you, limited to your Attio permissions.",
        },
      ],
    },
    buildAuthUrl: async ({
      appCredentials,
      redirectUri,
      state,
      accessLevel,
    }) => {
      if (!appCredentials.clientId) {
        throw new Error("Attio OAuth client ID not configured");
      }
      const url = new URL("https://app.attio.com/authorize");
      url.searchParams.set("client_id", appCredentials.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      if (accessLevel === "user") {
        url.searchParams.set("token_level", "user");
        url.searchParams.set(
          "code_challenge",
          await pkceChallenge(await pkceVerifier(state)),
        );
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    },
    exchangeCode: async ({
      appCredentials,
      callbackParams,
      redirectUri,
      accessLevel,
    }) => {
      // Attio redirects back with `error` instead of a code when the user
      // declines, or when the app has no user scopes for a personal token.
      if (callbackParams.error) {
        throw new Error(
          `Attio authorization error: ${callbackParams.error} (${callbackParams.error_description ?? "no description"})`,
        );
      }
      if (!callbackParams.code) {
        throw new Error("Attio callback missing authorization code");
      }
      if (!appCredentials.clientId || !appCredentials.clientSecret) {
        throw new Error("Attio OAuth credentials not configured");
      }
      const requestedLevel = accessLevel === "user" ? "user" : "workspace";
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: callbackParams.code,
        redirect_uri: redirectUri,
        client_id: appCredentials.clientId,
        client_secret: appCredentials.clientSecret,
      });
      if (requestedLevel === "user") {
        if (!callbackParams.state) {
          throw new Error("Attio callback missing state parameter");
        }
        body.set("code_verifier", await pkceVerifier(callbackParams.state));
      }
      const tokenRes = await fetch("https://app.attio.com/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      if (!tokenRes.ok) {
        throw new Error(
          `Attio token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        token_type?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        throw new Error(
          tokenData.error_description ?? "Failed to exchange code for token",
        );
      }

      // Attio issues non-expiring access tokens with no refresh grant, so
      // only persist expiry/refresh fields if the token response ever carries
      // them (keeps the stored credential honest rather than fabricating a TTL).
      const expiresAt = tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : undefined;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
      };
      if (tokenData.refresh_token) {
        credentials.refresh_token = tokenData.refresh_token;
      }
      if (expiresAt !== undefined) {
        credentials.expires_at = expiresAt;
      }

      let self: AttioSelf | null = null;
      let metadata: Record<string, unknown> = {};
      const selfRes = await fetch("https://api.attio.com/v2/self", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (selfRes.ok) {
        self = (await selfRes.json()) as AttioSelf;
        const authorizedBy = self.authorized_by_workspace_member_id;

        metadata = {
          workspaceName: self.workspace_name,
          workspaceId: self.workspace_id,
          workspaceSlug: self.workspace_slug,
          avatarUrl: self.workspace_logo_url,
        };

        const membersRes = await fetch(
          "https://api.attio.com/v2/workspace_members",
          {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          },
        );

        if (membersRes.ok) {
          const membersData = (await membersRes.json()) as {
            data?: {
              id?: { workspace_member_id?: string };
              first_name?: string;
              last_name?: string;
              email_address?: string;
              avatar_url?: string;
            }[];
          };

          const member = membersData.data?.find(
            (m) => m.id?.workspace_member_id === authorizedBy,
          );

          if (member) {
            const name = [member.first_name, member.last_name]
              .filter(Boolean)
              .join(" ");
            metadata.username = member.email_address ?? name;
            metadata.email = member.email_address;
            metadata.name = name;
            if (member.avatar_url) {
              metadata.avatarUrl = member.avatar_url;
            }
          }
        }
      }

      // What Attio actually granted, from `/v2/self`: the token's level, and
      // its scopes (a user-level token holds only those the installing admin
      // approved). What was requested stands in only when that lookup failed.
      const grantedLevel =
        self?.token_level === "user" || self?.token_level === "workspace"
          ? self.token_level
          : requestedLevel;
      const grantedScopes =
        typeof self?.scope === "string"
          ? self.scope.split(/\s+/).filter(Boolean)
          : [];

      return {
        credentials,
        scopes: grantedScopes.length
          ? grantedScopes
          : permissions.map((p) => p.scope),
        // The `accessLevels` option this connection holds; the connection
        // card shows its label so the two kinds can be told apart.
        metadata: { ...metadata, accessLevel: grantedLevel },
      };
    },
  },
  // Alternate to OAuth: bring your own Attio API key, scoped as narrowly as you
  // like. Validated and described via the same /v2/self call the OAuth flow uses.
  additionalMethods: [
    {
      type: "api_key",
      fields: [
        {
          name: "apiKey",
          label: "API key",
          description:
            "Create a scoped key in Attio under Settings → Developers, granting only the access your agents need.",
          placeholder: "<your Attio API key>",
          secret: true,
          helpUrl:
            "https://attio.com/help/apps/other-apps/generating-an-api-key",
          helpLabel: "How to create a scoped API key",
        },
      ],
      resolveMetadata: async (fields) => {
        const res = await fetch("https://api.attio.com/v2/self", {
          headers: { Authorization: `Bearer ${fields.apiKey}` },
        }).catch(() => null);
        // A rejected key is a user error, not a transient one: fail loudly so
        // we don't store a dead connection.
        if (res && (res.status === 401 || res.status === 403)) {
          throw new Error(
            "Attio rejected this API key. Double-check the key and that it has the scopes your agents need.",
          );
        }
        if (res?.ok) {
          const self = (await res.json().catch(() => null)) as {
            workspace_id?: string;
            workspace_name?: string;
            workspace_slug?: string;
            workspace_logo_url?: string;
          } | null;
          if (self?.workspace_id) {
            return {
              workspaceName: self.workspace_name,
              workspaceId: self.workspace_id,
              workspaceSlug: self.workspace_slug,
              username: self.workspace_name,
              avatarUrl: self.workspace_logo_url,
            };
          }
        }
        // Other failures (network, unexpected shape) are non-fatal.
        return null;
      },
    },
  ],
  // CRM integrations are Team-tier in OneCLI (matches HubSpot, Zoho, Affinity).
  configurable: {
    hint: "Create an OAuth app at build.attio.com.",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "secret_...",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "ATTIO_CLIENT_ID",
      clientSecret: "ATTIO_CLIENT_SECRET",
    },
  },
};
