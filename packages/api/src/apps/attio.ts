import type { AppDefinition } from "./types";

export const attio: AppDefinition = {
  id: "attio",
  name: "Attio",
  icon: "/icons/attio.svg",
  darkIcon: "/icons/attio-light.svg",
  description: "Contacts, companies, deals, lists, notes, and tasks.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [],
    permissions: [
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
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, state }) => {
      const url = new URL("https://app.attio.com/authorize");
      url.searchParams.set("client_id", appCredentials.clientId!);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      const tokenRes = await fetch("https://app.attio.com/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callbackParams.code!,
          redirect_uri: redirectUri,
          client_id: appCredentials.clientId!,
          client_secret: appCredentials.clientSecret!,
        }).toString(),
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

      let metadata: Record<string, unknown> | undefined;
      const selfRes = await fetch("https://api.attio.com/v2/self", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      if (selfRes.ok) {
        const self = (await selfRes.json()) as {
          workspace_id?: string;
          workspace_name?: string;
          workspace_slug?: string;
          workspace_logo_url?: string;
          authorized_by_workspace_member_id?: string;
        };

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
            (m) =>
              m.id?.workspace_member_id ===
              self.authorized_by_workspace_member_id,
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

      const scopes = [
        "record_permission:read-write",
        "object_configuration:read-write",
        "list_entry:read-write",
        "list_configuration:read-write",
        "note:read-write",
        "task:read-write",
        "comment:read-write",
        "file:read-write",
        "webhook:read-write",
        "user_management:read",
        "meeting:read-write",
        "call_recording:read",
      ];

      return { credentials, scopes, metadata };
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
