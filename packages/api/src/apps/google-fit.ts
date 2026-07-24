import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
  googleEnvDefaults,
} from "./oauth/google";

export const googleFit: AppDefinition = {
  id: "google-fit",
  name: "Google Fit",
  icon: "/icons/google-fit.svg",
  description: "Read activity and fitness data from Google Fit.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/fitness.activity.read",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/fitness.activity.read",
        name: "Activity data",
        description: "View activity and fitness data stored in Google Fit",
        access: "read",
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
    envDefaults: googleEnvDefaults,
  },
};
