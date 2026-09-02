import type { AppDefinition } from "./types";

export const fathom: AppDefinition = {
  id: "fathom",
  name: "Fathom",
  icon: "/icons/fathom.svg",
  darkIcon: "/icons/fathom-light.svg",
  description: "AI meeting notes: recordings, transcripts, and summaries.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: ["public_api"],
    permissions: [
      {
        scope: "public_api",
        name: "Public API",
        description: "Access meetings, recordings, transcripts, and summaries",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes, state }) => {
      const url = new URL("https://fathom.video/external/v1/oauth2/authorize");
      url.searchParams.set("client_id", appCredentials.clientId!);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      const tokenRes = await fetch(
        "https://api.fathom.ai/external/v1/oauth2/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: appCredentials.clientId!,
            client_secret: appCredentials.clientSecret!,
            code: callbackParams.code!,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        },
      );

      if (!tokenRes.ok) {
        throw new Error(
          `Fathom token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        token_type?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        throw new Error(
          tokenData.error_description ?? "Failed to exchange code for token",
        );
      }

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

      const scopes = tokenData.scope?.split(" ").filter(Boolean) ?? [];

      const metadata: Record<string, unknown> = {};
      const authHeaders = {
        Authorization: `Bearer ${tokenData.access_token}`,
      };
      try {
        const userRes = await fetch(
          "https://api.fathom.ai/external/v1/team_members",
          { headers: authHeaders },
        );

        if (userRes.ok) {
          const body = (await userRes.json()) as {
            items?: { name?: string; email?: string }[];
          };
          const member = body.items?.[0];
          if (member?.email) {
            metadata.email = member.email;
            metadata.name = member.name;
            metadata.username = member.email;
          }
        }

        if (!metadata.email) {
          const meetingsRes = await fetch(
            "https://api.fathom.ai/external/v1/meetings?limit=1",
            { headers: authHeaders },
          );
          if (meetingsRes.ok) {
            const body = (await meetingsRes.json()) as {
              items?: {
                recorded_by?: { name?: string; email?: string };
              }[];
            };
            const recorder = body.items?.[0]?.recorded_by;
            if (recorder?.email) {
              metadata.email = recorder.email;
              metadata.name = recorder.name;
              metadata.username = recorder.email;
            }
          }
        }
      } catch (err) {
        console.warn("Fathom userinfo fetch error:", err);
      }

      return { credentials, scopes, metadata };
    },
  },
  configurable: {
    hint: "Register an OAuth app at fathom.video/marketplace_applications/new.",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "your-fathom-client-id",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "your-fathom-client-secret",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "FATHOM_CLIENT_ID",
      clientSecret: "FATHOM_CLIENT_SECRET",
    },
  },
};
