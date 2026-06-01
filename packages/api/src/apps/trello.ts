import type { AppDefinition } from "./types";

export const trello: AppDefinition = {
  id: "trello",
  name: "Trello",
  icon: "/icons/trello.svg",
  description: "Boards, lists, and cards for project management.",
  connectionMethod: {
    type: "oauth",
    fragmentCallback: { paramName: "token" },
    defaultScopes: ["read", "write", "account"],
    permissions: [
      {
        scope: "read",
        name: "Boards & Cards",
        description: "Read boards, lists, cards, and organizations",
        access: "read",
      },
      {
        scope: "write",
        name: "Boards & Cards",
        description: "Create and modify boards, lists, and cards",
        access: "write",
      },
      {
        scope: "account",
        name: "Account",
        description: "Read member email and profile info",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, scopes }) => {
      const url = new URL("https://trello.com/1/authorize");
      url.searchParams.set("key", appCredentials.clientId!);
      url.searchParams.set("return_url", redirectUri);
      url.searchParams.set("callback_method", "fragment");
      url.searchParams.set("scope", scopes.join(","));
      url.searchParams.set("expiration", "never");
      url.searchParams.set("response_type", "token");
      url.searchParams.set("name", "OneCLI");
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams }) => {
      const token = callbackParams.token;
      if (!token) {
        throw new Error("No token received from Trello");
      }

      const userRes = await fetch(
        `https://api.trello.com/1/members/me?key=${encodeURIComponent(appCredentials.clientId!)}&token=${encodeURIComponent(token)}&fields=id,fullName,username,email,avatarHash`,
      );

      let metadata: Record<string, unknown> | undefined;
      if (userRes.ok) {
        const user = (await userRes.json()) as {
          id?: string;
          fullName?: string;
          username?: string;
          email?: string;
          avatarHash?: string;
        };
        metadata = {
          username: user.username,
          name: user.fullName,
          email: user.email,
          avatarUrl: user.avatarHash
            ? `https://trello-members.s3.amazonaws.com/${user.id}/${user.avatarHash}/170.png`
            : undefined,
        };
      }

      return {
        credentials: {
          access_token: token,
          apiKey: appCredentials.clientId,
        },
        scopes: ["read", "write", "account"],
        metadata,
      };
    },
  },
  available: true,
  configurable: {
    hint: "Create a Power-Up at trello.com/power-ups/admin to get your API key.",
    fields: [
      {
        name: "clientId",
        label: "API Key",
        placeholder: "Your Trello API key",
      },
      {
        name: "clientSecret",
        label: "API Secret",
        placeholder: "Your Trello API secret",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "TRELLO_API_KEY",
      clientSecret: "TRELLO_API_SECRET",
    },
  },
};
