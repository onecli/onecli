import type { AppDefinition } from "./types";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  googleConfigFields,
} from "./google-oauth";

export const googleAdmin: AppDefinition = {
  id: "google-admin",
  name: "Google Admin",
  icon: "/icons/google-admin.svg",
  description: "Manage users, groups, and devices in Google Workspace.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/admin.directory.user",
    ],
    permissions: [
      {
        scope: "https://www.googleapis.com/auth/admin.directory.user",
        name: "Admin Directory",
        description: "Manage users, groups, and devices",
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
