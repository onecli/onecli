import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./google-oauth";

export const googleAnalytics: AppDefinition = {
  id: "google-analytics",
  name: "Google Analytics",
  icon: "/icons/google-analytics.svg",
  description: "Access report data and run analytics queries.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/analytics",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/analytics",
        name: "Analytics",
        description: "Access analytics data and reports",
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
