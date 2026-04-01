import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./google-oauth";

export const googleSearchConsole: AppDefinition = {
  id: "google-search-console",
  name: "Google Search Console",
  icon: "/icons/google-search-console.svg",
  description: "View search traffic data and manage site presence.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/webmasters",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/webmasters",
        name: "Search Console",
        description: "View search traffic and manage site presence",
        access: "write",
      },
      {
        scope: "https://www.googleapis.com/auth/userinfo.email",
        name: "Email address",
        description: "View your email address",
        access: "read",
      },
      {
        scope: "https://www.googleapis.com/auth/userinfo.profile",
        name: "Profile",
        description: "Name and profile picture",
        access: "read",
      },
    ],
    buildAuthUrl: buildGoogleAuthUrl,
    exchangeCode: exchangeGoogleCode,
  },
  available: true,
  configurable: {
    fields: googleConfigFields,
  },
};
